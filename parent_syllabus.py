"""
NAADI AI — CONCEPT STUDIO SYLLABUS  (parent_syllabus.py)
═══════════════════════════════════════════════════════════════════════════

ONE loader, ONE cache, for the parent portal's view of the Concept Studio
syllabus.

WHY THIS FILE EXISTS

parent_home.py needed chapter COUNTS for its reading bars. parent_learning
needs the chapter NAMES for its syllabus map. Those came from the same
collection, and the obvious move — a second reader in the second file —
is how you end up with two caches that disagree about what the syllabus
is, and a page that says "9 of 28" next to a map with 27 tiles.

So: one read, one cache, two shapes derived from it. studio_syllabus()
keeps the exact signature parent_home.py already imports, so nothing on
that page changes.

───────────────────────────────────────────────────────────────────────────
THE SCHEMA, AND WHY IT IS READ DEFENSIVELY

    revision_chapters/{class}_{subject}
        ncert_class      12
        subject          "Biology"
        total_chapters   28
        chapters         [ {chapter_id, chapter_name, ...}, ... ]

    revision_chapters/{class}_{subject}/chapters/{chapter_id}
        chapter_id       "Biology_12_Genetics"

The `chapters` array on the parent doc is the cheap path: one read per
subject-year, about six reads for the whole syllabus. The subcollection is
the fallback for any doc where the array was never written, which
backend.py's own reader (_home_studio) already allows for by falling back
to total_chapters.

Field names inside the array are read with fallbacks because this file
does not own that schema — the Studio uploader does. A chapter that
arrives with `name` instead of `chapter_name` must still appear on the
map, because a missing tile reads to a parent as "not uploaded" rather
than as our bug.
"""

from datetime import datetime, timezone

from portal_backend import _db
from teacher_signals import canon_subject


# The same three minutes chapter_meta and the home page's caches use. A
# newly uploaded chapter must reach a parent in minutes, not at the next
# restart -- a missing TTL here is a visible content gap, not an
# optimisation detail.
_TTL = 180
_cache = {"at": 0.0, "data": None}


def invalidate_studio_syllabus():
    """Call after a Concept Studio upload so the next read is fresh."""
    _cache["data"] = None


def _s(v, limit=200):
    return "" if v is None else str(v)[:limit]


def _i(v, default=0):
    try:
        if isinstance(v, bool):
            return default
        return int(v)
    except (TypeError, ValueError):
        return default


def _pick(d, *names):
    """First non-empty of several possible field names."""
    for n in names:
        v = d.get(n)
        if v not in (None, "", 0):
            return v
    return ""


def _chapter_number(cid, name, fallback):
    """Best-effort ordering key. Never raises, never reorders wrongly on
    purpose -- an unparseable number sorts by name, which is at least
    stable between loads."""
    n = _i(fallback, 0)
    return n if n > 0 else 0


def studio_chapters(force=False):
    """{(subject, class_level): [ {id, name, number}, ... ]}

    Ordered by chapter number where one exists, then by name, so the map
    reads in syllabus order rather than in whatever order Firestore
    happened to return.
    """
    now = datetime.now(timezone.utc).timestamp()
    if not force and _cache["data"] is not None and now - _cache["at"] < _TTL:
        return _cache["data"]

    out = {}
    try:
        for doc in _db().collection("revision_chapters").stream():
            d = doc.to_dict() or {}

            # Fields first, doc id second. A doc-id rename must not
            # silently move a whole subject-year to a different bucket.
            parts = str(doc.id).split("_", 1)
            lvl = _s(_pick(d, "ncert_class", "class")
                     or (parts[0] if parts else ""), 8).strip()
            sub = canon_subject(
                _pick(d, "subject") or (parts[1] if len(parts) > 1 else ""))
            if sub == "Unassigned":
                continue

            rows = []
            arr = d.get("chapters")
            if isinstance(arr, list) and arr:
                for i, ch in enumerate(arr):
                    if not isinstance(ch, dict):
                        continue
                    cid = _s(_pick(ch, "chapter_id", "id"), 200)
                    nm = _s(_pick(ch, "chapter_name", "name", "title"), 160)
                    if not cid and not nm:
                        continue
                    rows.append({
                        "id": cid or nm,
                        "name": nm or cid,
                        "number": _chapter_number(
                            cid, nm, _pick(ch, "chapter_number", "number",
                                           "order", "index") or (i + 1)),
                    })
            else:
                # Fallback: the chapters subcollection. Costs one extra
                # read per subject-year and only runs for docs whose
                # array was never written.
                try:
                    for c in _db().collection("revision_chapters") \
                            .document(doc.id).collection("chapters").stream():
                        cd = c.to_dict() or {}
                        rows.append({
                            "id": _s(_pick(cd, "chapter_id", "id") or c.id, 200),
                            "name": _s(_pick(cd, "chapter_name", "name",
                                             "title") or c.id, 160),
                            "number": _i(_pick(cd, "chapter_number", "number",
                                               "order"), 0),
                        })
                except Exception as e:
                    print(f"[syllabus] subcollection read failed for "
                          f"{doc.id}: {e}")

            if not rows:
                continue

            # Deduplicate: a chapter present in both the array and the
            # subcollection must appear once, or the denominator inflates.
            seen, uniq = set(), []
            for r in rows:
                if r["id"] in seen:
                    continue
                seen.add(r["id"])
                uniq.append(r)

            uniq.sort(key=lambda r: (r["number"] or 9999, r["name"].lower()))
            out.setdefault((sub, lvl), []).extend(uniq)
    except Exception as e:
        print(f"[syllabus] revision_chapters read failed: {e}")

    _cache.update({"at": now, "data": out})
    return out


def studio_syllabus(force=False):
    """{(subject, class_level): total_chapters}

    Derived from studio_chapters() rather than counted separately, so the
    reading bar's denominator and the map's tile count can never disagree.
    parent_home.py imports this name and this shape.
    """
    return {k: len(v) for k, v in studio_chapters(force=force).items()}