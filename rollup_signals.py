"""
NAADI AI — ROLLUP SIGNALS  (rollup_signals.py)
═══════════════════════════════════════════════════════════════════════════

THE PROBLEM THIS SOLVES

The teacher portal's new home page speaks in sentences, not metrics:

    "Scored under 40% in his last 4 Chemistry tests."
    "Averaging 19s per question — the class averages 47s."
    "Read 6 chapters in Concept Studio but never tested on any of them."
    "Scored 168/720 in the 2023 paper — Physics 31/180."

Every one of those needs data the rollup did NOT carry. `overall_mastery`
is a lifetime blend, `studio_pct` is a single global number, and
`last_arena_score` is one integer with no subject split. Computing the
sentences live would mean, per class of 50, reading test_sessions +
pyq_sessions + revision_progress for every student on every page load —
roughly 400+ document reads each time a teacher opens the app. That is
precisely the cost the rollup architecture exists to prevent.

So the signals are computed ONCE, in the same pass that already rebuilds
the rollup, and stored on it under `signals`. The teacher portal then
renders every sentence from the 50 reads it was already doing.

Cost: ~2KB per student document, two extra collection queries per rebuild
(both of which the rollup builder was already streaming for other reasons
— see WIRING below, where we reuse rather than re-query where possible).

───────────────────────────────────────────────────────────────────────────
FIELDS ADDED FOR THE CLASS TAB

Two additions beyond the original flag-driving set. Both reuse queries that
were already running, so neither costs an extra read:

  studio_by_chapter  {chapter_id: pct}
      Per-chapter Concept Studio completion. The rollup only ever carried
      studio_pct — ONE global number — which cannot answer "how far is
      11th Chemistry through the studio" or "who read Hydrocarbons but
      never tested on it". Rounded to whole percents, opened chapters only.

  arena_by_paper     {"{year}_{paper}": {marks, max, subjects, attempts}}
      BEST attempt per paper. last_arena_score is the latest attempt and
      arena_best is one global maximum; neither can produce "class average
      on the 2023 paper", which is the only arena question a teacher asks.
      Best-per-paper because a class average built from latest attempts
      punishes the student who retried and slipped.

───────────────────────────────────────────────────────────────────────────
WIRING — how to install this

1.  Drop this file next to portal_backend.py.

2.  In portal_backend.py, near the other imports at the top:

        from rollup_signals import build_signals

3.  In rebuild_student_rollup(), find the `rollup = {` dict literal
    (~line 820) and add ONE line inside it, anywhere:

        "signals": build_signals(uid, meta, per_chapter),

    That is the entire integration. build_signals owns its own queries and
    its own failures — if it raises, it returns an empty-but-valid block
    and the rollup still writes. A signals bug can never take down the
    student portal.

4.  Nothing else changes. Existing fields are untouched, so the parent
    portal and the old teacher screens keep working during the rollout.

───────────────────────────────────────────────────────────────────────────
WHY EVERY NUMBER HERE IS GATED

A teacher acts on these sentences. A sentence generated from two data
points is not an observation, it is a coin flip with a name attached to
it. Every signal in this file carries the sample it was computed from, and
the flag layer (teacher_signals.py) refuses to render any sentence whose
sample is below the floor. "We don't know yet" is a real answer and it is
always better than a confident wrong one about a fifteen-year-old.
"""

from datetime import datetime, timezone, timedelta

# ── Sample floors ──────────────────────────────────────────────────────
# Nothing renders below these. Chosen so that a student in their first
# week of the app triggers nothing at all.
MIN_TESTS_FOR_TREND = 3      # tests before a "recent scores" claim is fair
MIN_Q_FOR_PACE = 20          # questions before a pace claim is fair
RECENT_TEST_WINDOW = 8       # how many recent tests we keep per student
RECENT_DAYS = 45             # tests older than this are not "recent"

# A retake replays the same session minutes later. Its score measures
# short-term recall, and its timing measures a student clicking through
# questions they have already read. Both are excluded from trends.
# (This mirrors the v3-audit reasoning already in portal_backend.)


def _iso_dt(iso_str):
    """Parse an ISO string back to an aware datetime, or None."""
    if not iso_str:
        return None
    try:
        s = str(iso_str).replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _days_ago(iso_str):
    dt = _iso_dt(iso_str)
    if not dt:
        return None
    return (datetime.now(timezone.utc) - dt).days


# ═══════════════════════════════════════════════════════════════════════
# THE STUDIO ↔ OPD CHAPTER-ID BRIDGE
#
# Concept Studio and OPD identify the same chapter with different ids,
# in different collections, and nothing links them:
#
#   Concept Studio   revision_chapters/{class}_{subject}/chapters/{id}
#                    id format documented in backend.py line ~6905:
#                        "{Subject}_{class}_{ChapterName}"
#                    e.g.  Chemistry_11_HYDROCARBONS
#                          Biology_12_MICROBES_IN_HUMAN_WELFARE
#
#   OPD / portal     chapter_metadata/{chapter_id}
#                    a different scheme entirely
#
# Joining Studio progress to chapter_metadata by raw id therefore matches
# NOTHING, which is why the Class tab reported "0 of 2 students have
# opened at least one" for a chapter a student had visibly worked through.
#
# This normalises both sides to a comparison key built from the chapter
# NAME — the only field the two systems agree on — after stripping the
# subject and class prefixes the Studio adds. Matching on name is not
# elegant, but the alternative is a migration of live student progress,
# and a lookup that degrades to "no match" is far safer than one that
# silently pairs the wrong chapters.
#
# If you later add an `opd_chapter_id` field to the Studio chapter docs,
# delete all of this and join on it directly.
# ═══════════════════════════════════════════════════════════════════════

_SUBJECT_WORDS = ("biology", "physics", "chemistry", "botany", "zoology",
                  "bio", "phy", "chem")


def _norm_key(s):
    """Lowercase alphanumerics only. 'Human Physiology' == 'human_physiology'."""
    return "".join(ch for ch in str(s or "").lower() if ch.isalnum())


def studio_key(chapter_id, chapter_name=""):
    """Comparison key for a Concept Studio chapter.

    Strips a leading "{Subject}_{class}_" if present, then normalises what
    remains. Prefers the human name when the doc carries one, since that
    is what chapter_metadata stores.
    """
    if chapter_name:
        return _norm_key(chapter_name)
    parts = str(chapter_id or "").split("_")
    # Drop leading subject and bare class-number segments.
    while parts and (parts[0].lower() in _SUBJECT_WORDS or parts[0].isdigit()):
        parts.pop(0)
    return _norm_key("".join(parts)) or _norm_key(chapter_id)


def build_studio_index(meta):
    """{comparison key -> chapter_metadata id} for the whole syllabus."""
    idx = {}
    for cid, m in (meta or {}).items():
        for cand in (m.get("chapter_title"), cid):
            k = _norm_key(cand)
            if k and k not in idx:
                idx[k] = cid
    return idx


def match_studio_chapter(studio_id, studio_name, index):
    """Resolve a Studio chapter to a chapter_metadata id, or None.

    Returns None rather than guessing. An unmatched chapter is reported
    as unmatched — a wrong match would put one chapter's reading progress
    against another chapter's test scores, which is worse than a gap.
    """
    k = studio_key(studio_id, studio_name)
    if not k:
        return None
    if k in index:
        return index[k]
    # Containment, but only when exactly one candidate fits. Two matches
    # means ambiguity, and ambiguity resolves to None.
    hits = [v for kk, v in index.items()
            if len(kk) > 4 and (kk in k or k in kk)]
    return hits[0] if len(set(hits)) == 1 else None


def _empty():
    """A valid, renderable signals block that claims nothing.

    Returned on any failure. Every consumer must treat this as "no data",
    never as "zero" — which is why counts are 0 but every RATE is None.
    """
    return {
        "recent_tests": [],
        "tests_in_window": 0,
        "recent_avg_pct": None,
        "recent_low_streak": 0,
        "low_streak_subject": "",
        "pace_seconds_per_q": None,
        "pace_sample": 0,
        "studio_read_not_tested": [],
        "studio_read_not_tested_count": 0,
        "tested_without_reading": 0,
        # chapter_id -> studio completion %. Powers the Class tab's studio
        # coverage filter and the same-chapter studio-vs-tested split.
        # Costs nothing extra: revision_progress is already streamed below.
        "studio_by_chapter": {},
        "studio_opened_chapters": [],
        "studio_unmatched": [],
        "studio_only_chapters": [],
        "studio_docs_seen": 0,
        "studio_engagement": {},
        "arena_last": None,
        "arena_best": None,
        # "{year}_{paper_code}" -> best attempt on THAT paper. The rollup's
        # last_arena_score is one latest number and arena_best is one global
        # best; neither can answer "class average on the 2023 paper", which
        # is the only arena question a teacher actually asks.
        "arena_by_paper": {},
        "chapters_by_subject": {},
        "chapters_by_subject_class": {},
        "computed_at": "",
    }


def _iso(ts):
    """Firestore timestamp / datetime / string → ISO string."""
    if not ts:
        return ""
    if isinstance(ts, str):
        return ts
    try:
        return ts.isoformat()
    except Exception:
        return str(ts)


# ═══════════════════════════════════════════════════════════════════════
# THE BUILDER
# ═══════════════════════════════════════════════════════════════════════

def build_signals(uid, meta, per_chapter=None, db=None):
    """Compute the recent-signals block for one student.

    uid          student uid
    meta         chapter_meta() output — chapter_id → {subject, class, ...}
    per_chapter  the per_chapter dict the rollup builder just computed.
                 Passed in rather than re-derived so we do not re-stream
                 user_progress for a second time.
    db           injectable Firestore client, for tests. Defaults to the
                 portal's own _db().

    Never raises. Returns _empty() on any failure.
    """
    try:
        if db is None:
            from portal_backend import _db as _portal_db
            db = _portal_db()
        return _build(uid, meta or {}, per_chapter or {}, db)
    except Exception as e:
        print(f"[signals] build failed for {uid}: {e}")
        return _empty()


def _build(uid, meta, per_chapter, db):
    out = _empty()
    cutoff = datetime.now(timezone.utc) - timedelta(days=RECENT_DAYS)

    # ── 1 · RECENT CHAPTER TESTS ───────────────────────────────────────
    # Feeds:  "under 40% in his last N Chemistry tests"
    #         "averaging Xs per question"
    #
    # We read test_sessions once and derive BOTH the score trend and the
    # pace from the same pass — pace lives on the session document
    # (time_taken_seconds / total_questions), so it costs nothing extra.
    tests = []
    pace_secs = 0
    pace_qs = 0

    try:
        for doc in db.collection("test_sessions") \
                .where("user_id", "==", uid) \
                .where("status", "==", "completed").stream():
            s = doc.to_dict() or {}
            at = _iso(s.get("completed_at"))
            dt = _iso_dt(at)
            if dt and dt < cutoff:
                continue

            cid = s.get("chapter_id", "")
            m = meta.get(cid, {})
            is_retake = bool(s.get("is_retake"))

            qs = s.get("questions", []) or []
            nq = int(s.get("total_questions", 0) or 0) or len(qs)
            secs = int(s.get("time_taken_seconds", 0) or 0)

            # Pace: real attempts only, and only where the numbers are
            # sane. A session with 0 questions or a 6-hour duration is an
            # abandoned tab, not a fast or slow student.
            if not is_retake and nq > 0 and 0 < secs < 3 * 3600:
                pace_secs += secs
                pace_qs += nq

            tests.append({
                "session_id": s.get("session_id", doc.id),
                "chapter_id": cid,
                "chapter_name": m.get("chapter_title", "") or s.get("chapter_name", ""),
                # Unmapped chapters are real: chapter_metadata.subject
                # defaults to "". Bucketing them as "Unassigned" keeps them
                # visible instead of silently vanishing from every subject
                # card and making the class look further behind than it is.
                "subject": m.get("subject", "") or "Unassigned",
                "pct": round(float(s.get("percentage") or 0), 1),
                "is_retake": is_retake,
                "questions": nq,
                "seconds": secs,
                "at": at,
            })
    except Exception as e:
        print(f"[signals] test_sessions read failed for {uid}: {e}")

    tests.sort(key=lambda t: t["at"], reverse=True)
    real = [t for t in tests if not t["is_retake"]]

    out["recent_tests"] = tests[:RECENT_TEST_WINDOW]
    out["tests_in_window"] = len(real)

    if len(real) >= MIN_TESTS_FOR_TREND:
        window = real[:5]
        out["recent_avg_pct"] = round(
            sum(t["pct"] for t in window) / len(window), 1)

        # Consecutive sub-40 run, newest first. This is deliberately a
        # STREAK and not an average: three 35s in a row is a different
        # conversation from a 90, a 20 and a 35, and averaging hides that.
        streak = 0
        for t in real:
            if t["pct"] < 40:
                streak += 1
            else:
                break
        out["recent_low_streak"] = streak
        if streak >= 2:
            subs = {t["subject"] for t in real[:streak]}
            out["low_streak_subject"] = subs.pop() if len(subs) == 1 else ""

    if pace_qs >= MIN_Q_FOR_PACE:
        out["pace_seconds_per_q"] = round(pace_secs / pace_qs, 1)
        out["pace_sample"] = pace_qs

    # ── 2 · STUDIO READ vs TESTED ──────────────────────────────────────
    # Feeds:  "Read 6 chapters but never tested on any of them"
    #         "Took 4 tests without opening the study material"
    #
    # This is the signal no competitor has, and it distinguishes two
    # completely different students who currently look identical: the one
    # who studies and won't test (usually anxiety) and the one who tests
    # without studying (usually guessing).
    read_not_tested = []
    tested_not_read = 0
    try:
        # Studio ids are "{Subject}_{class}_{ChapterName}" and do NOT match
        # chapter_metadata ids. Everything below is keyed by the RESOLVED
        # chapter_metadata id so studio progress lines up with test data
        # for the same chapter. See the bridge helpers above.
        index = build_studio_index(meta)
        studio = {}
        studio_only = []
        raw_docs = []

        opened_map = {}
        for doc in db.collection("users").document(uid) \
                .collection("revision_progress").stream():
            d = doc.to_dict() or {}
            pct = float(d.get("completion_percentage", 0) or 0)
            name = d.get("chapter_name", "")
            raw_docs.append({"id": doc.id, "name": name, "pct": round(pct, 1)})

            # OPENED vs COMPLETED are different facts and the gap between
            # them is the whole "read it but never tested" signal.
            #
            #   blocks_completed  the student said they finished it
            #   blocks_opened     they demonstrably started it
            #
            # blocks_opened only exists once the visit patch ships (see
            # VISIT-TRACKING.md); until then it is absent and every
            # completed block still counts as opened, so nothing regresses.
            completed = d.get("blocks_completed", []) or []
            opened = d.get("blocks_opened", []) or []
            touched = len(set(completed) | set(opened))
            total_blocks = int(d.get("total_blocks", 0) or 0)

            # Resolve to the OPD chapter id when there is one, so studio
            # progress lines up with test data for the same chapter.
            #
            # When there ISN'T one, KEEP THE STUDIO ID as the key rather
            # than discarding the row. A chapter with reading material and
            # no question bank is a normal state — Studio content routinely
            # lands before the question bank does — and the merged syllabus
            # keys those chapters by their Studio id for exactly this
            # reason. Dropping them here is what made a chapter the student
            # had visibly read report 0% opened.
            resolved = match_studio_chapter(doc.id, name, index) or doc.id
            was_matched = resolved != doc.id

            # Two Studio docs could resolve to one chapter after a rename;
            # keep the furthest along rather than the last read.
            studio[resolved] = max(studio.get(resolved, 0.0), pct)
            prev = opened_map.get(resolved) or {}
            opened_map[resolved] = {
                "blocks_touched": max(prev.get("blocks_touched", 0), touched),
                "blocks_done": max(prev.get("blocks_done", 0), len(completed)),
                "blocks_total": max(prev.get("blocks_total", 0), total_blocks),
            }

            if not was_matched:
                # NOT a failure. The progress IS recorded above, keyed by
                # the Studio id. This list simply names the chapters that
                # have reading material but no question bank yet, so the
                # portal can label them "reading only" instead of implying
                # something went wrong.
                studio_only.append({"id": doc.id, "name": name,
                                    "pct": round(pct, 1)})

        # Rounded to whole percents, opened chapters only — ~83 chapters
        # stays well under 2KB.
        out["studio_by_chapter"] = {
            cid: round(pct) for cid, pct in studio.items() if pct > 0}
        out["studio_opened_chapters"] = sorted(studio.keys())
        # Chapters the student HAS read that we could not tie to the
        # syllabus. Surfaced rather than dropped: a growing list here means
        # the two id schemes have drifted again, and silently discarding it
        # is exactly how the original bug stayed invisible.
        # Kept under the old key for compatibility with any rollup that
        # has not been rebuilt yet; the meaning is now "reading-only",
        # not "lost".
        out["studio_unmatched"] = studio_only[:10]
        out["studio_only_chapters"] = studio_only[:10]
        out["studio_docs_seen"] = len(raw_docs)
        # Per chapter: how many blocks were touched at all vs finished.
        # "Touched but zero finished" is a student who is reading and not
        # committing — invisible in completion_percentage, which is exactly
        # the case a teacher most wants to catch early.
        out["studio_engagement"] = opened_map

        for cid, pct_done in studio.items():
            ch = per_chapter.get(cid) or {}
            tests_taken = int(ch.get("tests", 0) or 0)
            # Touched counts too: a student six blocks into a chapter who
            # has marked none of them done sits at 0% and would otherwise
            # be filed as "never opened it".
            eng = opened_map.get(cid) or {}
            touched = int(eng.get("blocks_touched", 0) or 0)
            if (pct_done > 0 or touched > 0) and tests_taken == 0:
                m = meta.get(cid, {})
                read_not_tested.append({
                    "chapter_id": cid,
                    "chapter_name": m.get("chapter_title", "") or cid,
                    "subject": m.get("subject", "") or "Unassigned",
                    "studio_pct": round(pct_done, 1),
                })

        for cid, ch in (per_chapter or {}).items():
            if int(ch.get("tests", 0) or 0) > 0 and studio.get(cid, 0) < 10:
                tested_not_read += 1
    except Exception as e:
        print(f"[signals] revision_progress read failed for {uid}: {e}")

    read_not_tested.sort(key=lambda c: -c["studio_pct"])
    out["studio_read_not_tested"] = read_not_tested[:6]
    out["studio_read_not_tested_count"] = len(read_not_tested)
    out["tested_without_reading"] = tested_not_read

    # ── 3 · ARENA / FULL PAPERS, WITH THE SUBJECT SPLIT ────────────────
    # Feeds:  "Scored 168/720 — Physics 31/180"
    #
    # score_data.subject_breakdown is already computed and stored by the
    # arena engine and has never been surfaced anywhere. Marks per subject
    # out of 180 is the frame every NEET teacher in India actually manages
    # against, and it was sitting unused in Firestore.
    try:
        best = None
        last = None
        last_at = ""
        by_paper = {}
        for doc in db.collection("pyq_sessions") \
                .where("user_id", "==", uid) \
                .where("status", "==", "completed").stream():
            s = doc.to_dict() or {}
            if s.get("test_type") != "full_paper":
                continue
            sd = s.get("score_data", {}) or {}
            marks = sd.get("total_marks")
            if marks is None:
                continue

            rec = {
                "marks": marks,
                "max_marks": sd.get("max_marks", 720),
                "accuracy": sd.get("accuracy"),
                "correct": sd.get("correct_count"),
                "wrong": sd.get("wrong_count"),
                "unattempted": sd.get("unattempted_count"),
                "year": s.get("year"),
                "paper_code": s.get("paper_code", ""),
                "subjects": _norm_subject_breakdown(sd.get("subject_breakdown")),
                "at": _iso(sd.get("completed_at")) or _iso(s.get("completed_at")),
            }
            if rec["at"] > last_at:
                last_at, last = rec["at"], rec
            if best is None or (marks or 0) > (best["marks"] or 0):
                best = rec

            # BEST per paper, not latest. A class average built from latest
            # attempts punishes the student who retried and slipped, and it
            # is not the number a teacher means by "how did we do on 2023".
            key = f"{s.get('year', '')}_{s.get('paper_code', '') or 'P1'}"
            cur = by_paper.get(key)
            if cur is None or (marks or 0) > (cur.get("marks") or 0):
                by_paper[key] = {
                    "marks": marks,
                    "max": rec["max_marks"],
                    "year": rec["year"],
                    "paper_code": rec["paper_code"],
                    "subjects": rec["subjects"],
                    "attempts": (cur or {}).get("attempts", 0) + 1,
                }
            elif cur is not None:
                cur["attempts"] = cur.get("attempts", 0) + 1

        out["arena_last"] = last
        out["arena_best"] = best
        out["arena_by_paper"] = by_paper
    except Exception as e:
        print(f"[signals] pyq_sessions read failed for {uid}: {e}")

    # ── 4 · PER-SUBJECT CHAPTER COUNTS ─────────────────────────────────
    # Feeds the three subject cards: how far the student is through each
    # subject, split into states a teacher recognises without a glossary.
    by_sub = {}
    by_sub_class = {}
    try:
        studio_map = out.get("studio_by_chapter", {}) or {}

        for cid, m in (meta or {}).items():
            sub = m.get("subject", "") or "Unassigned"
            lvl = str(m.get("class", "") or "").strip() or "?"

            b = by_sub.setdefault(sub, {
                "total": 0, "complete": 0, "testing": 0,
                "read_only": 0, "not_started": 0,
            })
            # Keyed "Biology|11". A class-12 student can never finish the
            # class-11 half of a subject, so a single Biology bucket caps
            # them at ~50% and reads as "behind" when they are on track.
            # Splitting by level is what makes the number honest.
            bc = by_sub_class.setdefault(f"{sub}|{lvl}", {
                "subject": sub, "class_level": lvl,
                "total": 0, "complete": 0, "testing": 0,
                "read_only": 0, "not_started": 0,
            })

            b["total"] += 1
            bc["total"] += 1

            ch = (per_chapter or {}).get(cid) or {}
            tests_taken = int(ch.get("tests", 0) or 0)
            spct = float(studio_map.get(cid, 0) or 0)

            if ch.get("complete"):
                k = "complete"
            elif tests_taken > 0:
                k = "testing"
            elif spct > 0:
                # Any progress at all counts as opened. The old floor was
                # 10%, which hid a student six concepts into a sixty-concept
                # chapter — visibly working, invisible to their teacher.
                k = "read_only"
            else:
                k = "not_started"
            b[k] += 1
            bc[k] += 1
    except Exception as e:
        print(f"[signals] subject bucketing failed for {uid}: {e}")

    out["chapters_by_subject"] = by_sub
    out["chapters_by_subject_class"] = by_sub_class
    out["computed_at"] = datetime.now(timezone.utc).isoformat()
    return out


def _norm_subject_breakdown(sb):
    """Normalise score_data.subject_breakdown into {Subject: {marks, max}}.

    Production has stored this in at least three shapes across app
    versions: a flat {"Physics": 42} map, a nested
    {"Physics": {"marks": 42, "max": 180}} map, and a list of
    {"subject": ..., "marks": ...} dicts. All three are accepted; anything
    else returns {} rather than throwing a dashboard 500.
    """
    if not sb:
        return {}
    out = {}
    try:
        if isinstance(sb, dict):
            for k, v in sb.items():
                if isinstance(v, dict):
                    marks = v.get("marks", v.get("total_marks", v.get("score")))
                    mx = v.get("max", v.get("max_marks", 180))
                elif isinstance(v, (int, float)) and not isinstance(v, bool):
                    marks, mx = v, 180
                else:
                    continue
                if marks is not None:
                    out[str(k)] = {"marks": marks, "max": mx}
        elif isinstance(sb, list):
            for item in sb:
                if not isinstance(item, dict):
                    continue
                name = item.get("subject") or item.get("name")
                marks = item.get("marks", item.get("total_marks", item.get("score")))
                if name and marks is not None:
                    out[str(name)] = {
                        "marks": marks,
                        "max": item.get("max", item.get("max_marks", 180)),
                    }
    except Exception:
        return {}
    return out