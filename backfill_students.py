"""
NAADI AI — ONE-TIME BACKFILL FOR THE STUDENTS TAB  (backfill_students.py)
═══════════════════════════════════════════════════════════════════════════

Run once, after deploying the Students tab. Then never again — everything
here becomes the nightly job's responsibility.

    python3 backfill_students.py --dry-run
    python3 backfill_students.py

WHAT IT DOES, AND WHY EACH PART IS NEEDED

1 · accuracy_7d_ago
    The roster's week-over-week arrow used to be a delta on
    overall_mastery drawn inside the accuracy column, which is a
    different number wearing the wrong label. It now rides on accuracy.

    No new history has to be generated: the nightly job has been writing
    an `accuracy` field into student_rollups/{uid}/mastery_history/{date}
    all along and nothing ever read it. This walks that subcollection and
    lifts the seven-day-old value onto the rollup so the arrow works on
    day one instead of a week from now.

    Students with no history that old get None, and None renders as no
    arrow at all. That is correct — not a zero, not a flat line.

2 · roll_no
    Students set this in Profile, but existing users/{uid} documents were
    written before the field existed. This copies whatever is already on
    the user document onto the rollup so the class report can be sorted
    on it immediately, and reports how many students still have none —
    which is the list a class teacher needs to chase.

3 · alert_flags
    The rollup's stored flags were written by _alert_flags(), which has
    been deleted. Its kinds ("inactive_7d", "mastery_below_40") match
    nothing in teacher_signals, so the PARENT portal's alert list would
    read empty until each student's next natural rebuild. This rebuilds
    every rollup so the switch to one flag engine lands atomically.

    That third step is the expensive one — it is a full rebuild per
    student. Skip it with --no-rebuild if you would rather let the
    nightly job pick it up, and accept that parent alerts are blank until
    it runs.

SAFETY
    --dry-run prints every change and writes nothing.
    Failures are per-student and never abort the run; the tail reports
    them. A student this script fails on is left exactly as it found them.
"""

import argparse
import os
import sys
from datetime import datetime, timedelta, timezone

import firebase_admin
from firebase_admin import credentials, firestore

# ── Firebase init, BEFORE portal_backend is imported ──────────────────
# Standalone script: nothing has called initialize_app() for us. Without
# this, portal_backend._db() raises "The default Firebase app does not
# exist" on the first line of work. Same order and guard as
# portal_scripts.py.
SERVICE_ACCOUNT_PATH = os.environ.get("FIREBASE_SERVICE_ACCOUNT",
                                      "serviceAccountKey.json")
if not firebase_admin._apps:
    if os.path.exists(SERVICE_ACCOUNT_PATH):
        firebase_admin.initialize_app(credentials.Certificate(SERVICE_ACCOUNT_PATH))
    else:
        firebase_admin.initialize_app()

# Imported AFTER firebase init — portal_backend gets its handle lazily.
from portal_backend import (  # noqa: E402
    _db, chapter_meta, rebuild_student_rollup)


def backfill(dry_run=False, rebuild=True):
    db = _db()
    d7 = (datetime.now(timezone.utc).date() - timedelta(days=7)).isoformat()

    meta = chapter_meta(force=True) if rebuild else None
    rollups = list(db.collection("student_rollups").stream())
    print(f"{len(rollups)} rollups. dry_run={dry_run} rebuild={rebuild}\n")

    stats = {
        "acc_set": 0, "acc_missing": 0,
        "roll_set": 0, "roll_missing": 0,
        "rebuilt": 0, "failed": 0,
    }
    no_roll = []

    for doc in rollups:
        uid = doc.id
        r = doc.to_dict() or {}
        name = (r.get("name") or uid)[:24]
        try:
            update = {}

            # ── 1 · accuracy_7d_ago from existing history ──────────────
            if r.get("accuracy_7d_ago") is None:
                h = db.collection("student_rollups").document(uid) \
                      .collection("mastery_history").document(d7).get()
                a7 = (h.to_dict() or {}).get("accuracy") if h.exists else None
                if a7 is not None:
                    update["accuracy_7d_ago"] = a7
                    stats["acc_set"] += 1
                else:
                    # Left as None on purpose. No arrow is the honest
                    # rendering of "we have nothing to compare against".
                    stats["acc_missing"] += 1

            # ── 2 · roll_no from the user document ─────────────────────
            if not r.get("roll_no"):
                u = db.collection("users").document(uid).get()
                roll = (u.to_dict() or {}).get("roll_no", "") if u.exists else ""
                if roll:
                    update["roll_no"] = str(roll).strip()
                    stats["roll_set"] += 1
                else:
                    stats["roll_missing"] += 1
                    no_roll.append((r.get("class_id", "?"), r.get("name", uid)))

            if update and not dry_run:
                db.collection("student_rollups").document(uid).set(
                    update, merge=True)

            # ── 3 · flags, via a full rebuild ──────────────────────────
            if rebuild and not dry_run:
                rebuild_student_rollup(uid, meta=meta)
                stats["rebuilt"] += 1

            bits = ", ".join(f"{k}={v}" for k, v in update.items()) or "-"
            print(f"  {name:24s} {bits}")

        except Exception as e:
            stats["failed"] += 1
            print(f"  {name:24s} FAILED {type(e).__name__}: {e}")

    print("\n" + "=" * 58)
    print(f"  accuracy_7d_ago set     {stats['acc_set']}")
    print(f"  no 7-day history yet    {stats['acc_missing']}  (no arrow — correct)")
    print(f"  roll_no set             {stats['roll_set']}")
    print(f"  roll_no still missing   {stats['roll_missing']}")
    print(f"  rollups rebuilt         {stats['rebuilt']}")
    print(f"  failed                  {stats['failed']}")

    if no_roll:
        print("\n  Students with no roll number — they set it in Profile:")
        for cid, nm in sorted(no_roll):
            print(f"    {cid:10s} {nm}")

    return 1 if stats["failed"] else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-rebuild", action="store_true",
                    help="skip the per-student rollup rebuild (parent alerts "
                         "stay blank until the nightly job runs)")
    a = ap.parse_args()
    sys.exit(backfill(dry_run=a.dry_run, rebuild=not a.no_rebuild))