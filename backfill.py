import firebase_admin
from firebase_admin import credentials

cred = credentials.Certificate("serviceAccountKey.json")
firebase_admin.initialize_app(cred)

from portal_backend import rebuild_student_rollup, chapter_meta, _db

CLASS_KEY = "2026_12-A"

meta = chapter_meta()
docs = list(_db().collection("student_rollups")
            .where("class_key", "==", CLASS_KEY).stream())

print(f"Found {len(docs)} students in {CLASS_KEY}")
for i, doc in enumerate(docs, 1):
    try:
        rebuild_student_rollup(doc.id, meta)
        print(f"  [{i}/{len(docs)}] {doc.id} done")
    except Exception as e:
        print(f"  [{i}/{len(docs)}] {doc.id} FAILED: {e}")
print("Backfill complete.")