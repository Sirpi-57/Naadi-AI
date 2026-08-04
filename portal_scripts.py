"""
NAADI AI — PORTAL SCRIPTS  (portal_scripts.py)
═══════════════════════════════════════════════════════════════════════════

Three jobs, one file. Run from the repo root (next to serviceAccountKey.json).

    python portal_scripts.py backfill
        Builds student_rollups for every existing student. Run once, after
        deploying portal_backend.py. Idempotent — safe to re-run.

    python portal_scripts.py nightly
        Cron this, once a day. Refreshes the two things an event-driven
        rollup writer CANNOT know:
          • alert_flags — "inactive for 7 days" is an event that never
            fires. No test submit happens, so no hook runs, so a silently
            disengaged student stays green forever.
          • mastery_7d_ago / mastery_30d_ago — the trend-arrow baselines.

    python portal_scripts.py create-class \\
        --school NAADI-CHN-014 --school-name "Velammal" --section 12-A --level 12
        Creates classes/{2026_12-A}.

    python portal_scripts.py add-teacher \\
        --email t@school.com --name "R. Kavitha" --class 2026_12-A
        Creates (or promotes) a teacher and attaches them to a class.
        Many teachers may share one class — this appends, never replaces.

    python portal_scripts.py check --uid <student_uid>
        Prints one student's rollup. Use this to eyeball the numbers.
"""

import os
import sys
import argparse
import secrets
from datetime import datetime, timezone, timedelta

import firebase_admin
from firebase_admin import credentials, firestore, auth as firebase_auth

SERVICE_ACCOUNT_PATH = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "serviceAccountKey.json")
if not firebase_admin._apps:
    if os.path.exists(SERVICE_ACCOUNT_PATH):
        firebase_admin.initialize_app(credentials.Certificate(SERVICE_ACCOUNT_PATH))
    else:
        firebase_admin.initialize_app()

db = firestore.client()

# Imported AFTER firebase init — portal_backend gets its handle lazily.
from portal_backend import (  # noqa: E402
    rebuild_student_rollup, chapter_meta, _days_since,
    _academic_year, _send_email, WEB_BASE, INVITE_TTL_DAYS,
)


# ═══════════════════════════════════════════════════════════════════════════
# BACKFILL
# ═══════════════════════════════════════════════════════════════════════════

def backfill():
    meta = chapter_meta(force=True)
    print(f"Loaded {len(meta)} chapters from chapter_metadata.")

    students = [d.id for d in db.collection("users").stream()
                if (d.to_dict() or {}).get("role", "student") == "student"]
    print(f"Found {len(students)} students. Building rollups...\n")

    ok = fail = 0
    for i, uid in enumerate(students, 1):
        try:
            r = rebuild_student_rollup(uid, meta=meta)
            if r:
                ok += 1
                print(f"  [{i}/{len(students)}] {r['name'][:24]:24s} "
                      f"mastery={r['overall_mastery']:5.1f}  "
                      f"tests={r['tests_completed']:3d}  "
                      f"flags={','.join(r['alert_flags']) or '-'}")
            else:
                print(f"  [{i}/{len(students)}] {uid} — skipped (not a student)")
        except Exception as e:
            fail += 1
            print(f"  [{i}/{len(students)}] {uid} — FAILED: {type(e).__name__}: {e}")

    print(f"\nDone. {ok} rollups written, {fail} failed.")


# ═══════════════════════════════════════════════════════════════════════════
# NIGHTLY
# ═══════════════════════════════════════════════════════════════════════════

def nightly():
    """Refresh time-decayed fields.

    Snapshot cadence: we store today's mastery into a small history doc,
    then read the 7-day and 30-day-old entries back out. That's cheaper and
    more honest than trying to reconstruct history from test_history, which
    a retake mutates.
    """
    meta = chapter_meta(force=True)
    today = datetime.now(timezone.utc).date().isoformat()
    d7 = (datetime.now(timezone.utc).date() - timedelta(days=7)).isoformat()
    d30 = (datetime.now(timezone.utc).date() - timedelta(days=30)).isoformat()

    rollups = list(db.collection("student_rollups").stream())
    print(f"Refreshing {len(rollups)} rollups...\n")

    for doc in rollups:
        uid = doc.id
        try:
            # Recompute from source, so a student who did nothing today still
            # gets accurate last_active / alert state.
            r = rebuild_student_rollup(uid, meta=meta)
            if not r:
                continue

            hist_ref = db.collection("student_rollups").document(uid) \
                         .collection("mastery_history")
            hist_ref.document(today).set({
                "date": today,
                "overall_mastery": r["overall_mastery"],
                "accuracy": r["accuracy"],
                "tests_completed": r["tests_completed"],
            })

            def read(day, field="overall_mastery"):
                d = hist_ref.document(day).get()
                return d.to_dict().get(field) if d.exists else None

            m7, m30 = read(d7), read(d30)
            # The roster's week-over-week arrow rides on ACCURACY. The
            # history documents have carried an `accuracy` field all along
            # -- it was written every night and never read.
            a7 = read(d7, "accuracy")

            # rebuild_student_rollup() already ran the one flag engine
            # (teacher_signals.flags_for) and wrote its output. There is
            # nothing to recompute here; the nightly job only owns the
            # trend baselines, which are the one thing an event-driven
            # rebuild cannot know.
            db.collection("student_rollups").document(uid).set({
                "mastery_7d_ago": m7,
                "mastery_30d_ago": m30,
                "accuracy_7d_ago": a7,
                "nightly_at": firestore.SERVER_TIMESTAMP,
            }, merge=True)
            flags = r.get("alert_flags", []) or []

            days = _days_since(r["last_active_at"])
            print(f"  {r['name'][:24]:24s} mastery={r['overall_mastery']:5.1f} "
                  f"(7d: {m7 if m7 is not None else '—'})  "
                  f"idle={days if days is not None else '—'}d  "
                  f"flags={','.join(flags) or '-'}")

        except Exception as e:
            print(f"  {uid} — FAILED: {type(e).__name__}: {e}")

    # ── Class-level daily aggregate ────────────────────────────────────
    # The teacher's 30-day engagement chart reads 30 of these documents.
    # Computed live it would mean reading every student's study_days
    # subcollection on every screen open — about 1,500 reads for one chart.
    _write_class_dailies(today)

    # Prune history older than 60 days so the subcollection stays small.
    cutoff = (datetime.now(timezone.utc).date() - timedelta(days=60)).isoformat()
    pruned = 0
    for doc in rollups:
        for h in db.collection("student_rollups").document(doc.id) \
                   .collection("mastery_history").stream():
            if h.id < cutoff:
                h.reference.delete()
                pruned += 1
    print(f"\nDone. Pruned {pruned} old history entries.")


def _write_class_dailies(today):
    """One document per class per day: active students, tests submitted,
    class average mastery. Written once, read thirty times."""
    classes = list(db.collection("classes").stream())
    print(f"\nAggregating {len(classes)} classes for {today}...")

    for cdoc in classes:
        key = cdoc.id
        roster = [d.to_dict() for d in db.collection("student_rollups")
                  .where("class_key", "==", key).stream()]
        roster = [r for r in roster if r.get("class_status") == "approved"]
        if not roster:
            continue

        active = sum(1 for r in roster if r.get("active_today"))
        avg = round(sum(r.get("overall_mastery", 0) for r in roster) / len(roster), 1)

        # Tests submitted today = today's cumulative count minus yesterday's
        # snapshot. Reconstructing it from test_history instead would lie, as
        # a retake rewrites history in place.
        yday = (datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat()
        tests = 0
        for r in roster:
            prev = db.collection("student_rollups").document(r["uid"]) \
                     .collection("mastery_history").document(yday).get()
            if prev.exists:
                tests += max(0, r.get("tests_completed", 0)
                             - prev.to_dict().get("tests_completed", 0))

        db.collection("classes").document(key).collection("daily") \
          .document(today).set({
              "date": today, "active": active, "tests": tests,
              "avg_mastery": avg, "students": len(roster),
          })

        db.collection("classes").document(key).update({"student_count": len(roster)})
        print(f"  {key:16s} {len(roster):3d} students · {active:3d} active · {tests:3d} tests · avg {avg}")


# ═══════════════════════════════════════════════════════════════════════════
# CLASS + TEACHER ONBOARDING (BD team)
# ═══════════════════════════════════════════════════════════════════════════

def create_class(args):
    year = args.year or _academic_year()
    section = args.section.upper().replace(" ", "")
    school = args.school.upper().replace(" ", "")
    key = f"{year}_{section}"

    ref = db.collection("classes").document(key)
    if ref.get().exists:
        print(f"Class {key} already exists. Nothing changed.")
        return

    ref.set({
        "class_key": key,
        "school_id": school,
        "school_name": args.school_name or school,
        "academic_year": year,
        "class_id": section,
        "class_level": args.level,
        "teacher_uids": [],
        "settings": {"peer_comparison_enabled": False},
        "student_count": 0,
        "created_at": firestore.SERVER_TIMESTAMP,
    })
    print(f"Created class {key}")
    print(f"  school_id : {school}")
    print(f"  Tell students to enter school code {school} and section {section}.")


def add_teacher(args):
    key = args.class_key
    cls = db.collection("classes").document(key).get()
    if not cls.exists:
        print(f"Class {key} does not exist. Run create-class first.")
        sys.exit(1)

    email = args.email.strip().lower()
    try:
        u = firebase_auth.get_user_by_email(email)
        existing = db.collection("users").document(u.uid).get()
        role = (existing.to_dict() or {}).get("role", "student") if existing.exists else None
        if role and role not in ("teacher", None):
            print(f"REFUSED: {email} is already a {role} account. "
                  f"One email, one role. Use a different address.")
            sys.exit(1)
        print(f"Found existing account for {email}")
        temp_pw = None
    except firebase_auth.UserNotFoundError:
        temp_pw = secrets.token_urlsafe(9)
        u = firebase_auth.create_user(email=email, password=temp_pw, display_name=args.name)
        print(f"Created Firebase account for {email}")

    db.collection("users").document(u.uid).set({
        "uid": u.uid,
        "email": email,
        "name": args.name,
        "role": "teacher",
        "class_keys": firestore.ArrayUnion([key]),
        "updated_at": firestore.SERVER_TIMESTAMP,
        "created_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)

    db.collection("classes").document(key).update({
        "teacher_uids": firestore.ArrayUnion([u.uid]),
    })

    print(f"Attached {args.name} to {key}")
    if temp_pw:
        print(f"\n  Temporary password: {temp_pw}")
        print(f"  Send it out-of-band, and have them change it via 'Forgot password'.")
        print(f"  It is NOT emailed by this script — emailed passwords are a")
        print(f"  compliance problem the moment a school asks about them.")


# ═══════════════════════════════════════════════════════════════════════════
# CHECK
# ═══════════════════════════════════════════════════════════════════════════

def check(uid):
    r = rebuild_student_rollup(uid)
    if not r:
        print(f"{uid} is not a student, or does not exist.")
        return
    import json
    printable = {k: v for k, v in r.items() if k != "updated_at"}
    print(json.dumps(printable, indent=2, default=str))


# ═══════════════════════════════════════════════════════════════════════════

def main():
    p = argparse.ArgumentParser(description="NAADI AI portal maintenance")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("backfill")
    sub.add_parser("nightly")

    cc = sub.add_parser("create-class")
    cc.add_argument("--school", required=True, help="e.g. NAADI-CHN-014")
    cc.add_argument("--school-name", default="")
    cc.add_argument("--section", required=True, help="e.g. 12-A")
    cc.add_argument("--level", default="12", help="11 | 12 | dropper")
    cc.add_argument("--year", type=int, default=None, help="academic year, default = auto")

    at = sub.add_parser("add-teacher")
    at.add_argument("--email", required=True)
    at.add_argument("--name", required=True)
    at.add_argument("--class", dest="class_key", required=True, help="e.g. 2026_12-A")

    ck = sub.add_parser("check")
    ck.add_argument("--uid", required=True)

    args = p.parse_args()

    if args.cmd == "backfill":
        backfill()
    elif args.cmd == "nightly":
        nightly()
    elif args.cmd == "create-class":
        create_class(args)
    elif args.cmd == "add-teacher":
        add_teacher(args)
    elif args.cmd == "check":
        check(args.uid)


if __name__ == "__main__":
    main()