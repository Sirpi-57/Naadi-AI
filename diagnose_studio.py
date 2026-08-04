"""
NAADI AI — STUDIO DIAGNOSTIC  (diagnose_studio.py)
═══════════════════════════════════════════════════════════════════════════

WHY THE CLASS TAB SHOWED 0% — now confirmed

Concept Studio and OPD identify the same chapter with different ids:

    Concept Studio   revision_chapters/{class}_{subject}/chapters/{id}
                     "{Subject}_{class}_{ChapterName}"
                     e.g. Chemistry_11_HYDROCARBONS
                     (format documented in backend.py, ~line 6905)

    OPD / portal     chapter_metadata/{chapter_id}
                     a different scheme entirely

Joining studio progress to chapter_metadata by raw id matched NOTHING, so
every chapter read reported 0%.

rollup_signals.py now bridges the two by normalising the chapter NAME —
the only field both systems agree on. This script verifies that bridge
against your live data and lists anything it still cannot resolve.

Run it after installing the new rollup_signals.py and re-running the
backfill:

    python diagnose_studio.py

Nothing is written. It only reads.
"""

import sys

import firebase_admin
from firebase_admin import credentials

# Match whatever backend.py does — adjust the path if yours differs.
if not firebase_admin._apps:
    cred = credentials.Certificate("serviceAccountKey.json")
    firebase_admin.initialize_app(cred)

from portal_backend import _db, chapter_meta  # noqa: E402

CLASS_KEY = "2026_12-A"


def main():
    db = _db()
    meta = chapter_meta()
    print(f"chapter_metadata: {len(meta)} chapters\n")

    students = list(db.collection("student_rollups")
                    .where("class_key", "==", CLASS_KEY).stream())
    print(f"students in {CLASS_KEY}: {len(students)}\n")
    if not students:
        print("No students. Check CLASS_KEY.")
        return

    for snap in students:
        uid = snap.id
        r = snap.to_dict() or {}
        print("=" * 70)
        print(f"{r.get('name', '?')}  ({uid})")
        print("=" * 70)

        # ── 1 · What is actually in revision_progress ──────────────────
        docs = list(db.collection("users").document(uid)
                    .collection("revision_progress").stream())
        print(f"\n  revision_progress documents: {len(docs)}")

        if not docs:
            print("  >>> CASE A — the collection is EMPTY for this student.")
            print("      Concept Studio v3 is writing progress somewhere else.")
            print("      Tell me which collection and the rollup can read it.")
        for d in docs:
            v = d.to_dict() or {}
            pct = v.get("completion_percentage")
            blocks = v.get("blocks_completed") or []
            total = v.get("total_blocks")
            in_meta = d.id in meta

            print(f"\n    doc id: {d.id}")
            print(f"      matches a chapter_metadata id : {in_meta}")
            if not in_meta:
                # Show near-misses so an id-format difference is obvious.
                near = [c for c in meta
                        if d.id.lower() in c.lower() or c.lower() in d.id.lower()]
                print(f"      >>> CASE C — no chapter matches this id.")
                if near:
                    print(f"          close matches in metadata: {near[:5]}")
            print(f"      completion_percentage         : {pct}")
            print(f"      blocks_completed              : {len(blocks)}")
            print(f"      total_blocks                  : {total}")

            # Any concept-shaped field is the smoking gun for CASE B.
            concept_keys = [k for k in v
                            if "concept" in k.lower() or "done" in k.lower()]
            if concept_keys:
                print(f"      CONCEPT-SHAPED FIELDS         : "
                      f"{ {k: v[k] for k in concept_keys} }")

            if in_meta and (pct in (0, 0.0, None)):
                print("      >>> CASE B — doc exists but the percentage is 0.")
                print("          Studio v3 counts CONCEPTS; this field counts")
                print("          BLOCKS. All keys on this doc:")
                print(f"          {sorted(v.keys())}")

        # ── 2 · What the rollup ended up storing ───────────────────────
        sig = r.get("signals") or {}
        if not sig:
            print("\n  signals: MISSING — rollup was not rebuilt with the new "
                  "rollup_signals.py. Restart Flask, then re-run backfill.")
        else:
            print(f"\n  signals.studio_by_chapter     : "
                  f"{sig.get('studio_by_chapter')}")
            print(f"  signals.studio_opened_chapters: "
                  f"{sig.get('studio_opened_chapters')}")
            print(f"  rollup.studio_pct             : {r.get('studio_pct')}")

        # ── 3 · Does the bridge resolve every doc? ─────────────────────
        try:
            from rollup_signals import build_studio_index, match_studio_chapter
            index = build_studio_index(meta)
            print("\n  ID BRIDGE:")
            for d in docs:
                v = d.to_dict() or {}
                name = v.get("chapter_name", "")
                resolved = match_studio_chapter(d.id, name, index)
                status = f"-> {resolved}" if resolved else "-> UNRESOLVED"
                print(f"    {d.id:48s} {status}")
                if not resolved:
                    print(f"      name on doc: {name!r}")
                    print("      >>> No chapter_metadata entry matches this "
                          "name. Either the chapter is not set up for this "
                          "class, or the titles differ between the two "
                          "collections.")
        except Exception as e:
            print(f"\n  bridge check failed: {e}")

        # ── 4 · Where their test activity is, for contrast ─────────────
        pc = r.get("per_chapter") or {}
        tested = [cid for cid, c in pc.items() if int(c.get("tests", 0) or 0) > 0]
        print(f"\n  chapters with tests taken     : {tested}")
        print("  (a chapter here but not above means they tested without "
              "the Studio recording anything)")
        print()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"FAILED: {e}", file=sys.stderr)
        raise