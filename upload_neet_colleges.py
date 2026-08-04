"""
NAADI AI — Upload NEET College Data to Firestore
=================================================
Uploads neet_colleges_2025_expanded.json (or any compatible file) to:

  Firestore:
    neet_colleges/{college_id}          ← one document per college (132 total)
    neet_meta/2025                      ← qualifying cutoff + score-to-AIR table
    neet_meta/index                     ← summary index for the predictor

Usage:
    python upload_neet_colleges.py
    python upload_neet_colleges.py --file path/to/custom.json
    python upload_neet_colleges.py --dry-run
    python upload_neet_colleges.py --bucket my-project.firebasestorage.app

The script is idempotent — safe to re-run; existing docs are overwritten.
"""

import sys
import json
import argparse
from pathlib import Path
from datetime import datetime

try:
    import firebase_admin
    from firebase_admin import credentials, firestore
except ImportError:
    print("ERROR: firebase-admin not installed.  Run:  pip install firebase-admin")
    sys.exit(1)


# ─────────────────────────────────────────────────────────────────────────────
# Firebase init  (same pattern as upload_revision.py)
# ─────────────────────────────────────────────────────────────────────────────

def init_firebase(storage_bucket: str = None):
    if not firebase_admin._apps:
        import os
        key_paths = [
            "serviceAccountKey.json",
            "firebase-service-account.json",
            os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", ""),
        ]
        key_path = next((p for p in key_paths if p and Path(p).exists()), None)
        if not key_path:
            print("ERROR: No Firebase service account key found.")
            print("Place serviceAccountKey.json here or set GOOGLE_APPLICATION_CREDENTIALS")
            sys.exit(1)

        cred = credentials.Certificate(key_path)
        sa   = json.loads(Path(key_path).read_text())
        project_id = sa["project_id"]

        bucket_name = storage_bucket or f"{project_id}.firebasestorage.app"
        firebase_admin.initialize_app(cred, {"storageBucket": bucket_name})
        print(f"  ✓ Firebase initialised  (key: {key_path})")

    return firestore.client()


# ─────────────────────────────────────────────────────────────────────────────
# Batch writer  (auto-commits every 450 writes)
# ─────────────────────────────────────────────────────────────────────────────

class BatchWriter:
    def __init__(self, db, dry_run=False):
        self.db      = db
        self.dry_run = dry_run
        self._batch  = db.batch() if not dry_run else None
        self._count  = 0
        self.total   = 0

    def set(self, ref, data, merge=False):
        if self.dry_run:
            self.total += 1
            return
        if merge:
            self._batch.set(ref, data, merge=True)
        else:
            self._batch.set(ref, data)
        self._count += 1
        self.total  += 1
        if self._count >= 450:
            self._commit()

    def _commit(self):
        if self._count and not self.dry_run:
            self._batch.commit()
            self._batch  = self.db.batch()
            self._count  = 0

    def flush(self):
        self._commit()


# ─────────────────────────────────────────────────────────────────────────────
# Field cleaners
# ─────────────────────────────────────────────────────────────────────────────

def _clean(value):
    """
    Recursively strip None values from dicts/lists so Firestore
    doesn't receive null fields where integers/strings are expected.
    Keeps 0 and False (they're meaningful).
    """
    if isinstance(value, dict):
        return {k: _clean(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [_clean(v) for v in value if v is not None]
    return value


def _build_college_doc(c: dict) -> dict:
    """
    Convert one college entry from the JSON into a clean Firestore document.
    All field names here MUST match exactly what backend.py reads.
    """
    return _clean({
        # ── Identity ──────────────────────────────────────────────
        "id":           c.get("id", ""),
        "name":         c.get("name", ""),
        "city":         c.get("city", ""),
        "district":     c.get("district", ""),
        "state":        c.get("state", ""),
        "type":         c.get("type", "Govt"),
        "counselling":  c.get("counselling", "MCC_AIQ"),
        "established":  c.get("established"),
        "mbbs_seats":   c.get("mbbs_seats", 0),

        # ── Fees ──────────────────────────────────────────────────
        "annual_fee_inr": c.get("annual_fee_inr"),
        "mgmt_fee_inr":   c.get("mgmt_fee_inr"),
        "nri_fee_inr":    c.get("nri_fee_inr"),

        # ── AIQ closing ranks (All India Rank) ────────────────────
        # aiq        = Round 1 closing rank from MCC
        # aiq_final_2025 = Last-round closing rank (preferred by backend)
        "aiq":             c.get("aiq", {}),
        "aiq_final_2025":  c.get("aiq_final_2025", {}),
        "aiq_2024_final":  c.get("aiq_2024_final", {}),

        # ── NEET scores at closing (Round 1) ──────────────────────
        # e.g. {"GN": 613, "OBC": 608, "SC": 566, "ST": 501}
        "aiq_scores_closing_2025": c.get("aiq_scores_closing_2025", {}),

        # ── TN State quota data ────────────────────────────────────
        # tn_state = {
        #   "OC":  {"open": 24, "close": 70},
        #   "BC":  {"open": null, "close": 1045, "R1_close": 1045},
        #   "MBC": {...}, "SC": {...}, "SCA": {...}, "ST": {...},
        #   "score_GN": 613, "score_OBC": 608, "score_MBC": 577,
        #   "score_SC": 566, "score_ST": 501
        # }
        "tn_state": c.get("tn_state", {}),

        # ── Data quality ──────────────────────────────────────────
        "confidence":      c.get("confidence", "medium"),
        "verified_sources": c.get("verified_sources", []),
        "tags":            c.get("tags", []),
    })


# ─────────────────────────────────────────────────────────────────────────────
# Main upload function
# ─────────────────────────────────────────────────────────────────────────────

def upload_colleges(json_file: str, dry_run: bool = False, storage_bucket: str = None):
    json_path = Path(json_file)
    if not json_path.exists():
        print(f"ERROR: File not found: {json_file}")
        sys.exit(1)

    print(f"\n{'='*64}")
    print(f"  NAADI AI — NEET College Data Upload")
    print(f"{'='*64}")
    print(f"  Source file  : {json_file}")
    print(f"  Dry run      : {'YES (no writes)' if dry_run else 'NO (live writes)'}")

    with open(json_path, encoding="utf-8") as f:
        data = json.load(f)

    meta            = data.get("_meta", {})
    colleges        = data.get("colleges", [])
    qualifying      = data.get("qualifying_cutoff_2025", {})
    score_to_air    = data.get("score_to_air_2025", {})

    version         = meta.get("version", "unknown")
    total_colleges  = len(colleges)
    tn_count        = sum(1 for c in colleges if c.get("state") == "Tamil Nadu")
    non_tn_count    = total_colleges - tn_count

    print(f"  Version      : {version}")
    print(f"  Total colleges: {total_colleges}  (TN: {tn_count}, Outside TN: {non_tn_count})")
    print(f"{'='*64}")

    # Confidence breakdown
    conf = {}
    for c in colleges:
        cf = c.get("confidence", "?")
        conf[cf] = conf.get(cf, 0) + 1
    print(f"\n  Confidence:  " + "  ".join(f"{k}={v}" for k, v in sorted(conf.items())))

    if not dry_run:
        db = init_firebase(storage_bucket)
    else:
        db = None
        print("\n  [DRY RUN] No Firestore writes will be made.\n")

    writer = BatchWriter(db, dry_run=dry_run)

    # ── STEP 1: Upload individual college documents ───────────────────────────
    print(f"\n[1/3] Uploading {total_colleges} college documents → neet_colleges/{{id}} …")
    skipped = 0
    for c in colleges:
        college_id = c.get("id", "").strip()
        if not college_id:
            print(f"  ⚠  Skipping college with no id: {c.get('name', '?')}")
            skipped += 1
            continue

        doc = _build_college_doc(c)
        if not dry_run:
            ref = db.collection("neet_colleges").document(college_id)
            writer.set(ref, doc)
        else:
            writer.total += 1

        if writer.total % 25 == 0:
            print(f"  … {writer.total} written")

    print(f"  ✓ {total_colleges - skipped} college documents uploaded  ({skipped} skipped)")

    # ── STEP 2: Upload neet_meta/2025 ────────────────────────────────────────
    print(f"\n[2/3] Uploading neet_meta/2025  (qualifying cutoff + score→AIR table) …")
    meta_doc = _clean({
        "year":               2025,
        "qualifying_cutoff":  qualifying,
        "score_to_air":       score_to_air,
        "data_version":       version,
        "last_verified":      meta.get("last_verified", ""),
        "verification_notes": meta.get("verification_notes", []),
        "uploaded_at":        datetime.now().isoformat(),
    })
    if not dry_run:
        writer.set(db.collection("neet_meta").document("2025"), meta_doc)
    else:
        writer.total += 1
    print(f"  ✓ neet_meta/2025 uploaded")

    # ── STEP 3: Upload neet_meta/index ────────────────────────────────────────
    # Lightweight summary used by the college predictor at startup
    print(f"\n[3/3] Uploading neet_meta/index …")

    # Build a state → college count map
    state_counts = {}
    for c in colleges:
        st = c.get("state", "Unknown")
        state_counts[st] = state_counts.get(st, 0) + 1

    # Build a quick ID → name lookup for the frontend
    id_name_map = {c["id"]: c["name"] for c in colleges if c.get("id")}

    index_doc = _clean({
        "total_colleges":    total_colleges,
        "tn_colleges":       tn_count,
        "non_tn_colleges":   non_tn_count,
        "data_year":         2025,
        "data_version":      version,
        "state_counts":      state_counts,
        "college_id_list":   [c["id"] for c in colleges if c.get("id")],
        "id_name_map":       id_name_map,
        "confidence_counts": conf,
        "sources":           meta.get("data_sources", []),
        "uploaded_at":       datetime.now().isoformat(),
        "last_verified":     meta.get("last_verified", ""),
    })
    if not dry_run:
        writer.set(db.collection("neet_meta").document("index"), index_doc)
    else:
        writer.total += 1
    print(f"  ✓ neet_meta/index uploaded")

    # ── Flush any remaining writes ────────────────────────────────────────────
    if not dry_run:
        writer.flush()

    print(f"\n{'='*64}")
    if dry_run:
        print(f"  ✅ DRY RUN complete — {writer.total} documents would be written")
    else:
        print(f"  ✅ Upload complete!")
        print(f"  Total Firestore writes : {writer.total}")
        print(f"  Collections written to :")
        print(f"    neet_colleges/     → {total_colleges - skipped} docs  (one per college)")
        print(f"    neet_meta/2025     → 1 doc  (qualifying cutoff + score→AIR table)")
        print(f"    neet_meta/index    → 1 doc  (summary index)")
    print(f"{'='*64}\n")

    return {
        "colleges":  total_colleges - skipped,
        "skipped":   skipped,
        "writes":    writer.total,
        "dry_run":   dry_run,
    }


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Upload NEET college data JSON to Firestore."
    )
    parser.add_argument(
        "--file",
        default="neet_colleges_2025_expanded.json",
        help="Path to the colleges JSON file (default: neet_colleges_2025_expanded.json)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate and count documents without writing to Firestore",
    )
    parser.add_argument(
        "--bucket",
        default=None,
        help=(
            "Firebase Storage bucket (optional, same format as upload_revision.py). "
            "Only needed if Firebase init requires it. "
            "Example: my-project.firebasestorage.app"
        ),
    )
    args = parser.parse_args()

    result = upload_colleges(
        json_file      = args.file,
        dry_run        = args.dry_run,
        storage_bucket = args.bucket,
    )

    if result["dry_run"]:
        print(f"Dry run done.  Would write {result['writes']} documents.")
    else:
        print(
            f"Done.  Writes: {result['writes']}  |  "
            f"Colleges: {result['colleges']}  |  "
            f"Skipped: {result['skipped']}"
        )