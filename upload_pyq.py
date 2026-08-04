"""
NAADI AI — PYQ Upload Script
==============================
Uploads a NEET PYQ paper folder to Firebase Firestore + Storage.

Folder structure expected:
    NEET_UG_2025_60/
        export.json
        images/
            page2_img3.png
            Q2_expl_phys.png
            ...

Usage:
    python upload_pyq.py --folder /path/to/NEET_UG_2025_60 --service-account /path/to/serviceAccountKey.json

Requirements:
    pip install firebase-admin

What this script does:
    1. Reads export.json from the folder
    2. Uploads every image in images/ to Firebase Storage
       at path: pyq_images/{year}/{paper_code}/{filename}
    3. Builds an image_url_map: filename -> download URL
    4. Uploads each question to Firestore collection: pyq_questions
       Doc ID = question_id  (e.g. "NEET (UG)2025_C60_Q1")
    5. Creates/updates paper metadata in Firestore collection: pyq_papers
       Doc ID = "{year}_{paper_code}"  (e.g. "2025_60")
    6. Prints a summary report at the end
"""

import os
import sys
import json
import time
import argparse
import mimetypes
from pathlib import Path

# ─────────────────────────────────────────────────────────────
# DEPENDENCY CHECK
# ─────────────────────────────────────────────────────────────
try:
    import firebase_admin
    from firebase_admin import credentials, firestore, storage
except ImportError:
    print("❌  firebase-admin not installed.")
    print("    Run:  pip install firebase-admin")
    sys.exit(1)


# ─────────────────────────────────────────────────────────────
# ARGUMENT PARSING
# ─────────────────────────────────────────────────────────────
def parse_args():
    parser = argparse.ArgumentParser(
        description="Upload a NEET PYQ paper folder to Firebase."
    )
    parser.add_argument(
        "--folder",
        required=True,
        help="Path to the paper folder (e.g. /path/to/NEET_UG_2025_60)",
    )
    parser.add_argument(
        "--service-account",
        default="serviceAccountKey.json",
        help="Path to Firebase service account JSON (default: serviceAccountKey.json)",
    )
    parser.add_argument(
        "--storage-bucket",
        default=None,
        help=(
            "Firebase Storage bucket name (e.g. your-project.appspot.com). "
            "If omitted, the script reads it from the service account project_id."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse and validate data without uploading anything.",
    )
    parser.add_argument(
        "--skip-images",
        action="store_true",
        help="Skip image uploads (useful if images already uploaded).",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=400,
        help="Firestore batch commit size (max 500, default 400).",
    )
    return parser.parse_args()


# ─────────────────────────────────────────────────────────────
# FIREBASE INIT
# ─────────────────────────────────────────────────────────────
def init_firebase(service_account_path: str, storage_bucket: str | None):
    if not os.path.exists(service_account_path):
        print(f"❌  Service account file not found: {service_account_path}")
        sys.exit(1)

    with open(service_account_path) as f:
        sa = json.load(f)

    project_id = sa.get("project_id", "")
    bucket_name = storage_bucket or f"{project_id}.firebasestorage.app"

    print(f"🔑  Project : {project_id}")
    print(f"🪣  Bucket  : {bucket_name}")

    cred = credentials.Certificate(service_account_path)
    firebase_admin.initialize_app(cred, {"storageBucket": bucket_name})

    db = firestore.client()
    bucket = storage.bucket()
    return db, bucket, project_id


# ─────────────────────────────────────────────────────────────
# IMAGE UPLOAD
# ─────────────────────────────────────────────────────────────
def upload_images(images_dir: Path, year: int, paper_code: str, bucket, dry_run: bool):
    """
    Upload all files in images_dir to Firebase Storage.
    Storage path: pyq_images/{year}/{paper_code}/{filename}
    Returns dict: {filename: public_download_url}
    """
    image_url_map = {}

    if not images_dir.exists():
        print(f"  ⚠️  images/ folder not found at {images_dir}. Skipping image upload.")
        return image_url_map

    image_files = [
        f for f in images_dir.iterdir()
        if f.is_file() and not f.name.startswith(".")
    ]

    if not image_files:
        print("  ⚠️  No image files found in images/ folder.")
        return image_url_map

    print(f"\n📸  Uploading {len(image_files)} images...")

    for i, img_path in enumerate(sorted(image_files), 1):
        filename = img_path.name
        storage_path = f"pyq_images/{year}/{paper_code}/{filename}"

        mime_type, _ = mimetypes.guess_type(filename)
        if not mime_type:
            mime_type = "image/png"  # default

        if dry_run:
            fake_url = f"https://firebasestorage.googleapis.com/v0/b/BUCKET/o/pyq_images%2F{year}%2F{paper_code}%2F{filename}?alt=media"
            image_url_map[filename] = fake_url
            print(f"  [DRY RUN] {i}/{len(image_files)} {filename}")
            continue

        try:
            blob = bucket.blob(storage_path)
            blob.upload_from_filename(str(img_path), content_type=mime_type)
            blob.make_public()
            url = blob.public_url
            image_url_map[filename] = url
            print(f"  ✅ {i}/{len(image_files)} {filename}")
        except Exception as e:
            print(f"  ❌ {i}/{len(image_files)} {filename} — ERROR: {e}")
            # Store placeholder so questions still reference it
            image_url_map[filename] = f"UPLOAD_FAILED:{filename}"

    print(f"  📸  Images done: {len(image_url_map)} mapped")
    return image_url_map


# ─────────────────────────────────────────────────────────────
# QUESTION PROCESSING
# ─────────────────────────────────────────────────────────────
def build_question_doc(q: dict, image_url_map: dict, year: int, paper_code: str) -> dict:
    """
    Build a clean Firestore document from a raw question dict.
    Resolves image filenames to Storage URLs.
    Adds top-level fields needed for efficient querying.
    """

    def resolve_image(filename):
        if not filename:
            return None
        return image_url_map.get(filename, filename)  # fallback to original name

    # Resolve question images
    question_image_url = resolve_image(q.get("question_image_file"))
    question_image_urls = [
        resolve_image(f) for f in q.get("question_image_files", [])
        if f
    ]

    # Resolve explanation image
    explanation_image_url = resolve_image(q.get("explanation_image_file"))

    # Build options — resolve image_file filenames to Firebase Storage URLs
    raw_options = q.get("options", [])
    options = []
    for opt in raw_options:
        resolved_opt = dict(opt)
        img_file = opt.get("image_file")
        if img_file and not opt.get("image_url"):
            # Resolve bare filename to Firebase Storage public URL
            resolved_opt["image_url"] = resolve_image(img_file)
        options.append(resolved_opt)

    # ── Rewrite inline <img src="..."> paths in question_text and static_explanation ──
    # The pipeline embeds images as local paths like:
    #   /api/projects/NEET_UG_2025_60/images/custom_Q74_manual_xxx.png
    # We replace those src values with Firebase Storage public URLs.
    import re as _re

    def rewrite_inline_imgs(html_text):
        """Replace local /api/projects/.../images/filename src attrs with Storage URLs."""
        if not html_text:
            return html_text
        def replace_src(match):
            src = match.group(1)
            filename = src.split('/')[-1]
            if filename in image_url_map:
                return f'src="{image_url_map[filename]}"'
            return match.group(0)
        return _re.sub(r'src="([^"]*?/images/[^"]+)"', replace_src, html_text)

    question_text_resolved = rewrite_inline_imgs(q.get("question_text", ""))
    static_explanation_resolved = rewrite_inline_imgs(q.get("static_explanation", ""))

    # Build the document
    doc = {
        # ── Identity ──
        "question_id": q["question_id"],
        "year": year,
        "paper_code": paper_code,
        "question_number": q.get("question_number"),

        # ── Subject & Chapter ──
        "subject": q.get("subject", ""),
        "ncert_class": q.get("ncert_class"),
        "ncert_chapter_name": q.get("ncert_chapter_name", ""),
        "ncert_chapter_number": q.get("ncert_chapter_number"),
        "ncert_unit": q.get("ncert_unit", ""),

        # ── Content ──
        "render_mode": q.get("render_mode", "html"),
        "has_images": q.get("has_images", False),
        "has_table": q.get("has_table", False),
        "is_mta": q.get("is_mta", False),
        "mta_reason": q.get("mta_reason", ""),
        "is_match_question": q.get("is_match_question", False),
        "question_text": question_text_resolved,

        # ── Images (resolved URLs) ──
        "question_image_url": question_image_url,
        "question_image_urls": question_image_urls,
        "question_image_descriptions": q.get("question_image_descriptions", []),
        "explanation_image_url": explanation_image_url,
        "explanation_image_type": q.get("explanation_image_type", ""),

        # ── Options ──
        "options": options,
        "correct_answer": q.get("correct_answer", ""),

        # ── Classification ──
        "concept_id": q.get("concept_id", ""),
        "topic_tag": q.get("topic_tag", ""),
        "difficulty": q.get("difficulty", ""),
        "question_type": q.get("question_type", ""),
        "trap_type": q.get("trap_type", ""),
        "tags": q.get("tags", []),
        "revision_priority": q.get("revision_priority", ""),

        # ── Explanations ──
        "static_explanation": static_explanation_resolved,
        "each_option_explanation": q.get("each_option_explanation", {}),
        "ncert_verbatim": q.get("ncert_verbatim", ""),

        # ── Learning Aids ──
        "student_tip": q.get("student_tip", ""),
        "key_concept_summary": q.get("key_concept_summary", ""),
        "common_mistakes": q.get("common_mistakes", []),
        "revision_flashcard": q.get("revision_flashcard", {}),
        "alternate_question_forms": q.get("alternate_question_forms", []),

        # ── Meta ──
        "estimated_time_seconds": q.get("estimated_time_seconds", 90),
        "neet_marks": q.get("neet_marks", {
            "correct": 4, "incorrect": -1, "unattempted": 0, "is_mta": False
        }),

        # ── QA ──
        "qa_status": q.get("qa_status", "pending"),
        "validation_status": q.get("validation_status", "pending"),
        "validation_issues": q.get("validation_issues", ""),

        # ── Timestamp ──
        "uploaded_at": firestore.SERVER_TIMESTAMP,
    }

    return doc


# ─────────────────────────────────────────────────────────────
# PAPER METADATA
# ─────────────────────────────────────────────────────────────
def build_paper_doc(metadata: dict, year: int, paper_code: str, total_uploaded: int) -> dict:
    return {
        "paper_id": f"{year}_{paper_code}",
        "year": year,
        "paper_code": paper_code,
        "exam": metadata.get("exam", "NEET (UG)"),
        "total_questions": metadata.get("total_questions", total_uploaded),
        "total_uploaded": total_uploaded,
        "mta_questions": metadata.get("mta_questions", 0),
        "match_questions": metadata.get("match_questions", 0),
        "validation_flagged": metadata.get("validation_flagged", 0),
        "subjects": metadata.get("subjects", ["Physics", "Chemistry", "Biology"]),
        "chapters": metadata.get("chapters", []),
        "total_cost_inr": metadata.get("total_cost_inr", 0),
        "source": metadata.get("source", "NAADI AI PYQ Pipeline"),
        "exported_at": metadata.get("exported_at", ""),
        "uploaded_at": firestore.SERVER_TIMESTAMP,
    }


# ─────────────────────────────────────────────────────────────
# FIRESTORE BATCH UPLOAD
# ─────────────────────────────────────────────────────────────
def upload_questions_to_firestore(
    db,
    questions: list,
    image_url_map: dict,
    year: int,
    paper_code: str,
    batch_size: int,
    dry_run: bool,
):
    total = len(questions)
    print(f"\n📤  Uploading {total} questions to Firestore...")

    success_count = 0
    error_count = 0
    errors = []

    batch = None
    batch_count = 0

    # Only init batch if doing a real upload
    if not dry_run:
        batch = db.batch()

    for i, q in enumerate(questions, 1):
        question_id = q.get("question_id")
        if not question_id:
            print(f"  ⚠️  Q{i}: Missing question_id, skipping.")
            error_count += 1
            continue

        try:
            doc = build_question_doc(q, image_url_map, year, paper_code)
        except Exception as e:
            print(f"  ❌  Q{i} ({question_id}): Build error — {e}")
            error_count += 1
            errors.append({"question_id": question_id, "error": str(e)})
            continue

        if dry_run:
            # In dry run: just print every 20th question to avoid flooding console
            if i % 20 == 0 or i == total or i == 1:
                print(f"  [DRY RUN] Q{i}/{total}: {question_id}  ✓")
            success_count += 1
            continue

        ref = db.collection("pyq_questions").document(question_id)
        batch.set(ref, doc, merge=True)
        batch_count += 1
        success_count += 1

        # Commit batch when it hits the size limit
        if batch_count >= batch_size:
            print(f"  💾  Committing batch ({batch_count} docs)...")
            batch.commit()
            batch = db.batch()
            batch_count = 0
            time.sleep(0.5)  # Brief pause to avoid rate limits

        if i % 50 == 0 or i == total:
            print(f"  ⏳  Progress: {i}/{total} processed...")

    # Commit remaining
    if not dry_run and batch_count > 0:
        print(f"  💾  Committing final batch ({batch_count} docs)...")
        batch.commit()

    print(f"  ✅  Questions: {success_count} success, {error_count} errors")
    return success_count, errors


# ─────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────
def main():
    args = parse_args()

    folder = Path(args.folder).resolve()
    if not folder.exists():
        print(f"❌  Folder not found: {folder}")
        sys.exit(1)

    export_json = folder / "export.json"
    if not export_json.exists():
        print(f"❌  export.json not found in {folder}")
        print(f"    Looking for: {export_json}")
        sys.exit(1)

    images_dir = folder / "images"

    print("=" * 60)
    print("  NAADI AI — PYQ Upload Script")
    print("=" * 60)
    print(f"📁  Folder : {folder}")
    print(f"📄  JSON   : {export_json}")
    print(f"🖼️   Images : {images_dir}")
    print(f"🔁  Dry run: {args.dry_run}")
    print("=" * 60)

    # ── Load JSON ──
    print("\n📖  Loading export.json...")
    with open(export_json, encoding="utf-8") as f:
        data = json.load(f)

    metadata = data.get("metadata", {})
    questions = data.get("questions", [])

    year = int(metadata.get("year", 0))
    paper_code = str(metadata.get("paper_code", ""))

    if not year or not paper_code:
        print("❌  metadata.year and metadata.paper_code are required in export.json")
        sys.exit(1)

    print(f"✅  Loaded: Year={year}, Paper Code={paper_code}, Questions={len(questions)}")

    # ── Validate questions ──
    missing_ids = [i + 1 for i, q in enumerate(questions) if not q.get("question_id")]
    if missing_ids:
        print(f"⚠️  {len(missing_ids)} questions missing question_id at positions: {missing_ids[:10]}...")

    # ── Init Firebase ──
    if not args.dry_run:
        db, bucket, project_id = init_firebase(args.service_account, args.storage_bucket)
    else:
        print("\n[DRY RUN] Skipping Firebase init.")
        db, bucket = None, None

    # ── Upload Images ──
    image_url_map = {}
    if not args.skip_images:
        if args.dry_run:
            print("\n[DRY RUN] Simulating image upload...")
            # Build fake URL map for dry run
            if images_dir.exists():
                for f in images_dir.iterdir():
                    if f.is_file():
                        image_url_map[f.name] = f"https://storage.googleapis.com/BUCKET/pyq_images/{year}/{paper_code}/{f.name}"
            print(f"  [DRY RUN] Would upload {len(image_url_map)} images")
        else:
            image_url_map = upload_images(images_dir, year, paper_code, bucket, args.dry_run)
    else:
        print("\n⏭️   Skipping image upload (--skip-images flag set)")
        # Build URL map from known Firebase Storage pattern even if skipping
        if images_dir.exists():
            for f in images_dir.iterdir():
                if f.is_file():
                    storage_path = f"pyq_images/{year}/{paper_code}/{f.name}"
                    image_url_map[f.name] = (
                        f"https://storage.googleapis.com/"
                        f"{args.storage_bucket or 'YOUR_BUCKET'}/"
                        f"{storage_path}"
                    )

    # ── Upload Questions ──
    success_count, errors = upload_questions_to_firestore(
        db=db,
        questions=questions,
        image_url_map=image_url_map,
        year=year,
        paper_code=paper_code,
        batch_size=args.batch_size,
        dry_run=args.dry_run,
    )

    # ── Upload Paper Metadata ──
    paper_doc = build_paper_doc(metadata, year, paper_code, success_count)
    paper_id = f"{year}_{paper_code}"

    if not args.dry_run and db:
        print(f"\n📋  Saving paper metadata (ID: {paper_id})...")
        db.collection("pyq_papers").document(paper_id).set(paper_doc, merge=True)
        print(f"  ✅  Paper metadata saved.")
    else:
        print(f"\n[DRY RUN] Would save paper metadata: {paper_id}")

    # ── Summary ──
    print("\n" + "=" * 60)
    print("  UPLOAD SUMMARY")
    print("=" * 60)
    print(f"  Year / Paper Code : {year} / {paper_code}")
    print(f"  Questions uploaded : {success_count} / {len(questions)}")
    print(f"  Images mapped      : {len(image_url_map)}")
    print(f"  Errors             : {len(errors)}")

    if errors:
        print("\n  ❌  Errors:")
        for e in errors[:10]:
            print(f"    - {e['question_id']}: {e['error']}")
        if len(errors) > 10:
            print(f"    ... and {len(errors) - 10} more")

    # ── Save error log ──
    if errors:
        error_log_path = folder / "upload_errors.json"
        with open(error_log_path, "w") as f:
            json.dump(errors, f, indent=2)
        print(f"\n  📝  Error log saved: {error_log_path}")

    # ── Save URL map ──
    if image_url_map and not args.dry_run:
        url_map_path = folder / "image_url_map.json"
        with open(url_map_path, "w") as f:
            json.dump(image_url_map, f, indent=2)
        print(f"  🖼️   Image URL map saved: {url_map_path}")

    print("\n✅  Upload complete!")
    print("=" * 60)

    # ── Firestore paths for reference ──
    print("\n📍  Firestore paths created:")
    print(f"   pyq_papers/{paper_id}")
    print(f"   pyq_questions/NEET (UG){year}_C{paper_code}_Q1  (and Q2, Q3...)")
    print(f"\n📍  Storage path:")
    print(f"   pyq_images/{year}/{paper_code}/")


if __name__ == "__main__":
    main()