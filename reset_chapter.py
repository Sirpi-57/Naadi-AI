"""
Wipe YOUR TEST PROGRESS for one chapter. Content is NOT touched.

    python reset_chapter.py              # DRY RUN — counts only, deletes nothing
    python reset_chapter.py --commit     # actually delete

This deletes only per-student data. It does NOT delete questions or
chapter_metadata, because upload_qgen_chapter.py already does that itself
(delete_chapter_questions() wipes every question doc for the chapter before
writing the new ones). That split is deliberate and matches how the two scripts
describe themselves: the uploader owns CONTENT, this owns STUDENT STATE.

Order:
    1. python reset_chapter.py --commit                        (student state)
    2. python upload_qgen_chapter.py qgen_export.json imgs/    (content)
    3. open the chapter in the app

Why student state has to go: the progress doc caches test_plan (the entire
reservation) plus seen_question_ids. The new engine reserves DIFFERENT question
ids than the old one. generate_test() does replan on a content_signature
mismatch, but get_chapter_detail() does NOT -- it renders whatever test_plan is
already on the doc. Deleting leaves nothing stale to reason about.
"""
import sys
from pathlib import Path

try:
    import firebase_admin
    from firebase_admin import credentials, firestore
except ImportError:
    print("ERROR: pip install firebase-admin")
    sys.exit(1)

CHAPTER_ID = "Chemistry_11_Hydrocarbons"
COMMIT = "--commit" in sys.argv

if not firebase_admin._apps:
    key = next((p for p in ("serviceAccountKey.json", "firebase-service-account.json")
                if Path(p).exists()), None)
    if key:
        firebase_admin.initialize_app(credentials.Certificate(key))
    else:
        firebase_admin.initialize_app()
db = firestore.client()


def wipe(label, docs):
    docs = list(docs)
    print(f"  {label:<44} {len(docs):>5}")
    if not COMMIT or not docs:
        return len(docs)
    batch, n = db.batch(), 0
    for d in docs:
        batch.delete(d.reference)
        n += 1
        if n % 400 == 0:            # Firestore caps a batch at 500
            batch.commit()
            batch = db.batch()
    batch.commit()
    return len(docs)


print(f"\n{'DRY RUN — nothing will be deleted' if not COMMIT else '*** DELETING ***'}")
print(f"chapter: {CHAPTER_ID}\n")
total = 0

# The cached test_plan + phase_state + seen_question_ids + concept_mastery.
# Found by chapter_id, NOT by tests_completed -- opening the chapter page calls
# get_or_create_progress(), so an account that merely browsed in already has a
# full doc with zero tests taken. Those need to go too.
progress = [d for d in db.collection("user_progress").stream()
            if d.to_dict().get("chapter_id") == CHAPTER_ID]
uids = sorted({d.to_dict().get("user_id") for d in progress} - {None})
untested = sum(1 for d in progress if not d.to_dict().get("tests_completed"))
total += wipe("user_progress", progress)

# generate_test() resumes any in_progress session and re-fetches its question
# docs by id. After a re-upload those ids may no longer exist.
total += wipe("test_sessions",
              db.collection("test_sessions").where("chapter_id", "==", CHAPTER_ID).stream())

# determine_intervention() reads variation_history here for consecutive-failure
# counts. Stale entries mean v3 popups firing on the wrong bases.
total += wipe("base_question_tracking",
              [d for d in db.collection("base_question_tracking").stream()
               if f"_{CHAPTER_ID}_" in d.id])

# Cosmetic, but keeps the debug endpoint honest for a clean read.
total += wipe("test_debug_logs",
              [d for d in db.collection("test_debug_logs").stream()
               if d.to_dict().get("chapter_id") == CHAPTER_ID])
total += wipe("ai_interventions",
              [d for d in db.collection("ai_interventions").stream()
               if d.to_dict().get("chapter_id") == CHAPTER_ID])

print(f"\n  {'TOTAL':<44} {total:>5}")
print(f"\naccounts with a progress doc  : {len(uids)}")
print(f"  ...never took a test        : {untested}  (from just opening the chapter page)")
for u in uids:
    print(f"    {u}")
print("\nNOT touched: questions, chapter_metadata, Storage images")
print("            (upload_qgen_chapter.py deletes + rewrites those itself)")
print("\nRe-run with --commit to delete." if not COMMIT
      else "\nDone. Next: python upload_qgen_chapter.py qgen_export.json qgen_images/")