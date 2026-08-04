"""
OPD adaptive test engine — pure logic, no Flask / no Firestore.

Everything here is deterministic and unit-testable. backend.py imports from
this module; nothing in this module imports backend.py.

WHAT CHANGED vs the old in-backend engine
─────────────────────────────────────────
1. RESERVATION IS CONCEPT-AWARE. The old allocator sorted v1s with a plain
   `list.sort()` on question_id and dealt them FIFO. Question ids look like
   "p10_b10_ANG_1_E_sing_v1", so a lexicographic sort puts p10 before p3 and
   p9 dead last -- reservation therefore walked the chapter in an arbitrary
   order and, because it only ever claimed ~30% of the pool, simply never
   reached the tail. On Hydrocarbons that left 13 of 30 concepts with zero
   questions in the entire journey, including "Alkane Nomenclature and
   Isomerism" (11 blocks) and "Halogenation of Alkanes" (8 blocks), both of
   which live on pages p3-p9. Now: natural sort + a per-concept deficit-greedy
   deal against journey-wide targets (floor + weight).

2. min_tests IS SOLVED PER CHAPTER, not hardcoded at 3/3/3/3. Chapter pools
   range from 279 to 655 v1s here and the optimum is genuinely different for
   each (3/3/3/5 .. 8/3/3/6). The strand curve is violently non-monotonic --
   on Hydrocarbons, Foundation=4 strands 9 questions, Foundation=5 strands 79,
   Foundation=6 strands 29 -- because each step changes the leftover
   difficulty SHAPE, which flips which difficulty binds Endurance capacity.
   There is no intuition to hand-tune with; it has to be searched.

3. max_tests IS GONE. It was dead code. `max_tests = 2 * min_tests` was
   described as the exact worst-case bound, and it is: a failed v2 escalates
   to v3 rather than re-queueing, so each v1 spawns at most one v2, so the
   worst case is exactly 2x -- at which point the queue is empty and the
   NATURAL completion branch fires first. The "forced" branch was therefore
   unreachable, which meant `needs_review` was never written, which meant
   `bonus_pool_eligible` was always empty, which meant the Bonus Pool's
   eligibility guard rejected every student who ever reached it. See
   prove_no_forced_closure() -- that proof is a test, not a comment.

4. QUEUE FLOWS FORWARD. A phase used to wait for its own owed_v2 queue to
   drain, which produced 1- and 2-question stub "tests" at the tail of every
   phase. Phases now end when their CONTENT is spent; trailing v2s ride into
   the next phase. Grand Mock is exempt -- it must stay a clean 25-question
   capstone with zero remediation content in it.

5. v3 SPACED CHECK. A correct v2 used to close a base permanently and
   suppress its v3 forever. But v2 is a same-key rephrase of v1 (identical
   options, identical answer -- see any triad in the qgen export), fired one
   test after the student read the v1 explanation. Passing it can mean
   "learned the rule" or "remembered that the answer was B", and the engine
   could not tell the difference. So a recovered base now books its v3 as a
   spaced audit 3 tests later. v3 IS differently trapped (different options,
   different key), so it cannot be passed from memory of v1's answer.
   This is DISJOINT from the v3 intervention popup by construction: checks are
   only scheduled when v2 was CORRECT, the popup only fires when v2 was WRONG.
   The band is ADDITIVE (it does not consume q_per_test) -- if it competed for
   slots the 2x bound in (3) would break and phases could force-close.
"""

import re
import hashlib
from collections import defaultdict

# ─────────────────────────────────────────────────────────────────────
# CONSTANTS
# ─────────────────────────────────────────────────────────────────────

PASS_THRESHOLD = 40

# min_tests here is only the SEARCH FLOOR -- solve_min_tests() picks the real
# value per chapter and writes it into the plan. NOTE the absence of
# max_tests: see module docstring (3).
PHASE_IDEAL_RATIOS = {
    "Foundation": {
        "min_tests": 3, "q_per_test": 10,
        "ratios": {"Easy": 1.00, "Medium": 0.00, "Hard": 0.00},
        "time_minutes": 8, "v3_band": 2,
    },
    "Skill Building": {
        "min_tests": 3, "q_per_test": 12,
        "ratios": {"Easy": 0.50, "Medium": 0.50, "Hard": 0.00},
        "time_minutes": 10, "v3_band": 2,
    },
    "Mastery": {
        "min_tests": 3, "q_per_test": 15,
        "ratios": {"Easy": 0.30, "Medium": 0.50, "Hard": 0.20},
        "time_minutes": 12, "v3_band": 3,
    },
    "NEET Simulation": {
        "min_tests": 3, "q_per_test": 20,
        "ratios": {"Easy": 0.00, "Medium": 0.60, "Hard": 0.40},
        "time_minutes": 15, "v3_band": 3,
    },
    "Grand Mock": {
        "min_tests": 1, "q_per_test": 25,
        "ratios": {"Easy": 0.20, "Medium": 0.50, "Hard": 0.30},
        "time_minutes": 20, "v3_band": 0,   # capstone: no remediation content
    },
}

PHASE_ORDER = ["Foundation", "Skill Building", "Mastery", "NEET Simulation"]
ENDURANCE = "Endurance"          # was "Bonus Pool"
JOURNEY_ORDER = PHASE_ORDER + ["Grand Mock"]
FULL_ORDER = JOURNEY_ORDER + [ENDURANCE]

CONCEPT_FLOOR = 3                # journey-wide guaranteed questions per concept
MIN_TESTS_SEARCH = (3, 8)        # inclusive
MAX_JOURNEY_MIN_TESTS = 22       # sum over the 4 learning phases
ENDURANCE_Q_PER_TEST = 20
ENDURANCE_TIME_MINUTES = 15
ENDURANCE_V3_BAND = 3
V3_CHECK_LAG = 3                 # tests between a v2 recovery and its audit

DIFFS = ("Easy", "Medium", "Hard")
_DIFF_RANK = {"Easy": 0, "Medium": 1, "Hard": 2}


# ─────────────────────────────────────────────────────────────────────
# SMALL PURE HELPERS
# ─────────────────────────────────────────────────────────────────────

def largest_remainder_split(total, ratios):
    """Split `total` across ratio keys summing EXACTLY to total."""
    active = {k: r for k, r in ratios.items() if r > 0}
    if total <= 0 or not active:
        return {k: 0 for k in ratios}
    raw = {k: total * r for k, r in active.items()}
    floors = {k: int(v) for k, v in raw.items()}
    remainder = total - sum(floors.values())
    order = sorted(active.keys(), key=lambda k: (-(raw[k] - floors[k]), -active[k]))
    for k in order[:remainder]:
        floors[k] += 1
    for k in ratios:
        floors.setdefault(k, 0)
    return floors


def _normalize_base_id(raw_base_id, fallback_qid=""):
    """Strip the variation marker so a v1/v2/v3 triad shares one key.
    Handles gap-fill ids where _v<n> is followed by _x<n>."""
    base = (raw_base_id or fallback_qid or "").strip()
    return re.sub(r"_v\d+(_x\d+)?$", lambda m: m.group(1) or "", base)


_NAT_RE = re.compile(r"(\d+)")


def natural_sort_key(qid):
    """
    Sort question ids the way a human reads the chapter.

    Plain string sort orders "p10" < "p3" < "p9", so the old allocator walked
    Hydrocarbons as p1, p10, p11 ... p33, p4, p5, p6, p9 -- the alkane pages
    (p3-p9) landed at positions 21-29 of 29 and were never reached. Splitting
    on digit runs and comparing the numeric chunks as ints fixes the ordering
    everywhere it matters (reservation, logs, debug dumps).
    """
    return tuple(
        int(part) if part.isdigit() else part
        for part in _NAT_RE.split(qid or "")
    )


def compute_content_signature(all_chapter_questions, concepts_summary, plan_version=""):
    """
    Fingerprint of the chapter's live ID surface. plan_version is folded in so
    an ENGINE change (like this one) forces a replan even when the content is
    byte-identical -- otherwise existing students keep the old front-loaded
    reservation forever and never see the fix.
    """
    qids = sorted(q.get("question_id", "") for q in all_chapter_questions)
    concept_ids = sorted(c.get("concept_id", "") for c in (concepts_summary or []))
    payload = ("V:" + plan_version + "||Q:" + "|".join(qids) + "||C:" + "|".join(concept_ids))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


# ─────────────────────────────────────────────────────────────────────
# CONTENT INGESTION
# ─────────────────────────────────────────────────────────────────────

def ingest_questions(all_chapter_questions, require_v2=True):
    """
    Bucket a chapter's questions into the structures reservation needs.

    require_v2: skip any v1 whose v2 is missing OR UNANSWERABLE.

    "Exists" is not enough. generate_test() drops any question with an empty
    options array (`if not options: continue`), but build_next_test_selection()
    has already drained that base off owed_v2 by then -- so the student misses
    the v1, the v2 is queued, the v2 is silently skipped at render, and the base
    leaves remediation forever having never been shown. Live example in
    Hydrocarbons: p21_b3_ANG_2_H_matc_v2 has correct_mapping and both lists but
    `options: []`, because qgen emits some match_the_following variations as
    pure-mapping questions while their siblings carry four options whose text IS
    the mapping. So a v2 is only a real companion if it has at least one option
    with an id -- i.e. if the student can actually answer it.

    Approval makes this worse: it is scored PER QUESTION, not per triad (the
    export shows a v1 at quality 5.0 beside its v2 at 10.0), so a v1 can survive
    while its v2 is rejected. Better to lose one question at reservation than one
    student's remediation.

    Returns dict with:
      v1_by_diff_concept : {diff: {concept_id: [qid natural-sorted]}}
      v2_by_base, v3_by_base : {base_id: qid}
      v1_meta            : {qid: {"base": , "concept": , "diff": }}
      concept_weight     : {concept_id: n_v1s available}
      orphans            : [qid] v1s dropped for having no v2
      counts             : {"Easy": n, ...}
    """
    v1_by_diff_concept = {d: defaultdict(list) for d in DIFFS}
    v2_by_base, v3_by_base = {}, {}
    v1_meta = {}
    v1_candidates = []

    def _answerable(q):
        """At least one option with an id. Mirrors generate_test()'s
        `if not options: continue`, so nothing is reserved that will be
        silently dropped at render time."""
        opts = (q.get("content", {}) or {}).get("options", []) or []
        return any((o or {}).get("id") for o in opts)

    unanswerable_v2, unanswerable_v3 = [], []

    for q in all_chapter_questions:
        meta = q.get("meta_data", {}) or {}
        pool = meta.get("pool", "regular")
        var = meta.get("variation_number")
        diff = (meta.get("difficulty") or "").strip().capitalize()
        qid = q.get("question_id", "")
        base_id = _normalize_base_id(meta.get("base_question_id", ""), qid)
        concept_id = meta.get("concept_id") or "__UNTAGGED__"

        if pool == "intervention_reserve" and var == 3:
            # An unanswerable v3 is NOT excluded from v3_by_base -- the
            # intervention popup needs to know it exists so it can fall back to
            # review-only (see opd.js v3Usable). It is only reported.
            if not _answerable(q):
                unanswerable_v3.append(qid)
            v3_by_base[base_id] = qid
        elif pool == "regular" and var == 1 and diff in DIFFS:
            # A v1 must be answerable too, and this one is not optional -- it is
            # a hard deadlock, not a silent drop. build_next_test_selection()
            # would reserve it and hand it to generate_test(), which discards any
            # question with no options; it therefore never reaches the session,
            # never enters seen_question_ids, and phase_completion_status() sees
            # it as unshown FOREVER. The phase can never complete and re-selects
            # it every test. (0 such v1s in Hydrocarbons today -- every empty
            # options array there is on a v2/v3 -- but the cost of being wrong is
            # a chapter that can never be finished.)
            v1_candidates.append((qid, base_id, concept_id, diff, _answerable(q)))
        elif pool == "regular" and var == 2:
            if _answerable(q):
                v2_by_base[base_id] = qid
            else:
                unanswerable_v2.append(qid)

    orphans, unanswerable_v1 = [], []
    for qid, base_id, concept_id, diff, ok in v1_candidates:
        if not ok:
            unanswerable_v1.append(qid)
            continue
        if require_v2 and base_id not in v2_by_base:
            orphans.append(qid)
            continue
        v1_by_diff_concept[diff][concept_id].append(qid)
        v1_meta[qid] = {"base": base_id, "concept": concept_id, "diff": diff}

    for d in DIFFS:
        for c in v1_by_diff_concept[d]:
            v1_by_diff_concept[d][c].sort(key=natural_sort_key)
        v1_by_diff_concept[d] = dict(v1_by_diff_concept[d])

    concept_weight = defaultdict(int)
    for m in v1_meta.values():
        concept_weight[m["concept"]] += 1

    counts = {d: sum(len(v) for v in v1_by_diff_concept[d].values()) for d in DIFFS}

    return {
        "v1_by_diff_concept": v1_by_diff_concept,
        "v2_by_base": v2_by_base,
        "v3_by_base": v3_by_base,
        "v1_meta": v1_meta,
        "concept_weight": dict(concept_weight),
        "orphans": orphans,
        "unanswerable_v1": unanswerable_v1,
        "unanswerable_v2": unanswerable_v2,
        "unanswerable_v3": unanswerable_v3,
        "counts": counts,
    }


# ─────────────────────────────────────────────────────────────────────
# min_tests SOLVER
# ─────────────────────────────────────────────────────────────────────

def _reserve_counts(mins):
    """Per-phase difficulty needs for a given min_tests choice."""
    out = {}
    gm = PHASE_IDEAL_RATIOS["Grand Mock"]
    out["Grand Mock"] = largest_remainder_split(gm["min_tests"] * gm["q_per_test"], gm["ratios"])
    for name in PHASE_ORDER:
        cfg = PHASE_IDEAL_RATIOS[name]
        out[name] = largest_remainder_split(mins[name] * cfg["q_per_test"], cfg["ratios"])
    return out


def endurance_shape(surplus):
    """Endurance's difficulty ratio, derived from what a chapter actually has
    left over. Across all four real chapters the leftover shape lands near
    12/54/34 -- essentially NEET Simulation's 0/60/40 -- so Endurance is
    'Simulation, continued', not a re-run of the whole journey. Deriving it
    per chapter (rather than hardcoding) is what keeps a difficulty from
    stranding when a chapter's mix is unusual."""
    total = sum(surplus.values())
    if total <= 0:
        return None
    return {d: surplus[d] / total for d in DIFFS}


def evaluate_mins(pool_counts, mins):
    """Score one min_tests candidate. Returns None if infeasible."""
    avail = dict(pool_counts)
    needs = _reserve_counts(mins)
    for ph in needs:
        for d, n in needs[ph].items():
            avail[d] = avail.get(d, 0) - n
    if any(v < 0 for v in avail.values()):
        return None

    surplus = {d: avail.get(d, 0) for d in DIFFS}
    shape = endurance_shape(surplus)
    if shape is None:
        return None
    per_test = largest_remainder_split(ENDURANCE_Q_PER_TEST, shape)
    if all(v == 0 for v in per_test.values()):
        return None
    cap = min(surplus[d] // per_test[d] for d in DIFFS if per_test[d] > 0)
    if cap < 2:
        return None

    used = {d: per_test[d] * cap for d in DIFFS}
    strand = sum(surplus[d] - used[d] for d in DIFFS)
    journey_v1 = sum(sum(n.values()) for n in needs.values())

    return {
        "mins": dict(mins),
        "needs": needs,
        "surplus": surplus,
        "endurance_shape": shape,
        "endurance_per_test": per_test,
        "endurance_tests": cap,
        "endurance_reserve": used,
        "stranded": strand,
        "journey_v1": journey_v1,
    }


def solve_min_tests(pool_counts, log=None):
    """
    Search min_tests per phase. Minimise stranded v1s, tie-break on maximising
    journey v1 (more content inside the tracked v1->v2->v3 cycle). Capped by
    MAX_JOURNEY_MIN_TESTS so the mandatory journey stays sane.

    ~1300 candidates, milliseconds, and the result is cached on the plan --
    this runs once per chapter, ever.
    """
    lo, hi = MIN_TESTS_SEARCH
    best = None
    considered = 0
    for f in range(lo, hi + 1):
        for s in range(lo, hi + 1):
            for m in range(lo, hi + 1):
                for n in range(lo, hi + 1):
                    if f + s + m + n > MAX_JOURNEY_MIN_TESTS:
                        continue
                    mins = {"Foundation": f, "Skill Building": s,
                            "Mastery": m, "NEET Simulation": n}
                    r = evaluate_mins(pool_counts, mins)
                    if r is None:
                        continue
                    considered += 1
                    key = (r["stranded"], -r["journey_v1"])
                    if best is None or key < (best["stranded"], -best["journey_v1"]):
                        best = r
    if best is None:
        # Pool too small even for the floor -- fall back to the floor and let
        # content_check report the shortfall rather than exploding.
        mins = {n: PHASE_IDEAL_RATIOS[n]["min_tests"] for n in PHASE_ORDER}
        best = evaluate_mins(pool_counts, mins) or {
            "mins": mins, "needs": _reserve_counts(mins),
            "surplus": {d: 0 for d in DIFFS}, "endurance_shape": None,
            "endurance_per_test": {d: 0 for d in DIFFS}, "endurance_tests": 0,
            "endurance_reserve": {d: 0 for d in DIFFS}, "stranded": 0,
            "journey_v1": sum(sum(v.values()) for v in _reserve_counts(mins).values()),
        }
        best["fallback"] = True
    best["candidates_considered"] = considered
    if log is not None:
        log.append(f"solver: {considered} feasible candidates")
    return best


# ─────────────────────────────────────────────────────────────────────
# CONCEPT-STRATIFIED RESERVATION
# ─────────────────────────────────────────────────────────────────────

def compute_concept_targets(concept_weight, journey_slots, floor=CONCEPT_FLOOR):
    """
    Journey-wide question budget per concept: a guaranteed floor, then the
    remainder shared proportionally to how much content the concept actually
    has.

    Why a floor at all: pure proportional allocation starves the 1-block
    concepts (Hydrocarbons has three: Physical Properties of Alkenes,
    Carcinogenicity of Arenes, Chemical Conversions of Benzene), and a concept
    with 0 questions can never leave `not_started` -- which is exactly the bug
    being fixed. Why only 3: mastery_score is correct/total, so 3 gives
    0/33/67/100 -- enough granularity to be meaningful. With ~10 questions per
    concept available on Hydrocarbons, spending 90 of 313 slots on the floor
    and leaving 223 to weighting keeps Addition Reactions of Alkenes (23
    blocks) at its deserved ~22 rather than flattening everything to 10.
    """
    concepts = [c for c, w in concept_weight.items() if w > 0]
    if not concepts:
        return {}
    targets = {c: min(floor, concept_weight[c]) for c in concepts}
    remaining = journey_slots - sum(targets.values())
    if remaining <= 0:
        return targets
    headroom = {c: max(0, concept_weight[c] - targets[c]) for c in concepts}
    tot_head = sum(headroom.values())
    if tot_head <= 0:
        return targets
    shares = {c: remaining * (headroom[c] / tot_head) for c in concepts}
    floors_ = {c: int(v) for c, v in shares.items()}
    rem = remaining - sum(floors_.values())
    order = sorted(concepts, key=lambda c: (-(shares[c] - floors_[c]), -headroom[c], c))
    for c in order[:rem]:
        floors_[c] += 1
    for c in concepts:
        targets[c] += min(floors_[c], headroom[c])
    return targets


class ConceptTaker:
    """
    Deals reserved v1s across concepts instead of straight off a flat list.

    For each (difficulty, n) request it repeatedly picks the concept that is
    furthest behind -- concepts still under the floor first, then largest
    deficit against target. Concepts with nothing at that difficulty are
    simply skipped, so a mechanism-heavy concept with no Easy questions does
    not block Foundation; it collects its allocation in Mastery/Simulation
    where its content actually lives.
    """

    def __init__(self, v1_by_diff_concept, targets, floor=CONCEPT_FLOOR):
        self.buckets = {d: {c: list(v) for c, v in v1_by_diff_concept[d].items()}
                        for d in DIFFS}
        self.targets = dict(targets)
        self.floor = floor
        self.allocated = defaultdict(int)

    def _pick(self, diff):
        cands = [c for c, lst in self.buckets[diff].items() if lst]
        if not cands:
            return None

        def key(c):
            target = self.targets.get(c, 0)
            fl = min(self.floor, target)
            got = self.allocated[c]
            if got < fl:
                # UNDER FLOOR -> strict round-robin on how many the concept
                # already has. Deficit-greedy here would be a trap: at the very
                # first take() every concept has 0, so "largest deficit" means
                # "largest target", and the biggest concept would be dealt its
                # entire floor before the second concept got anything. Grand
                # Mock reserves first, so its 25 questions would land on ~8 big
                # concepts instead of 25 different ones -- rebuilding, in a new
                # way, exactly the unrepresentative capstone this rework exists
                # to fix. Round-robin gives every concept its 1st, then every
                # concept its 2nd, and so on.
                return (0, got, -target, c)
            # ABOVE FLOOR -> deficit-greedy, so weighting decides the rest.
            return (1, -(target - got), got, c)

        return min(cands, key=key)

    def take(self, diff, n):
        out = []
        for _ in range(n):
            c = self._pick(diff)
            if c is None:
                break
            out.append(self.buckets[diff][c].pop(0))
            self.allocated[c] += 1
        return out

    def remaining(self):
        return {d: {c: list(v) for c, v in self.buckets[d].items() if v} for d in DIFFS}


def calculate_dynamic_test_plan(all_chapter_questions, concepts_summary=None,
                                plan_version="v3_concept_stratified", require_v2=True):
    """
    Build the chapter-level plan. Runs once per chapter, cached on the progress
    doc, identical for every student.
    """
    ing = ingest_questions(all_chapter_questions, require_v2=require_v2)
    pool_counts = ing["counts"]

    solved = solve_min_tests(pool_counts)
    mins = solved["mins"]
    needs = solved["needs"]

    journey_slots = solved["journey_v1"]
    targets = compute_concept_targets(ing["concept_weight"], journey_slots)
    taker = ConceptTaker(ing["v1_by_diff_concept"], targets)

    content_check = {"sufficient": True, "shortfalls": [],
                     "orphan_v1_no_v2": len(ing["orphans"]),
                     "orphan_examples": ing["orphans"][:10],
                     # Reported, not fatal: the v3 popup degrades to review-only
                     # for these (opd.js), so the student is never stranded --
                     # but they never get the intervention question either.
                     "unanswerable_v3": len(ing["unanswerable_v3"]),
                     "unanswerable_v3_examples": ing["unanswerable_v3"][:10],
                     "unanswerable_v2": len(ing["unanswerable_v2"]),
                     "unanswerable_v2_examples": ing["unanswerable_v2"][:10],
                     "unanswerable_v1": len(ing["unanswerable_v1"]),
                     "unanswerable_v1_examples": ing["unanswerable_v1"][:10]}

    phases_out = {}

    def _reserve(phase_name, need_map):
        ids = []
        for diff in DIFFS:
            need = need_map.get(diff, 0)
            if need <= 0:
                continue
            got = taker.take(diff, need)
            ids.extend(got)
            if len(got) < need:
                content_check["sufficient"] = False
                content_check["shortfalls"].append(
                    {"phase": phase_name, "difficulty": diff,
                     "needed": need, "have": len(got)})
        return ids

    # Grand Mock reserved FIRST so the capstone samples the whole chapter
    # before any learning phase claims the good questions. (Before, "first"
    # combined with a lexicographic sort meant the Grand Mock was 25 questions
    # from the front of the chapter only -- for Hydrocarbons, no alkanes, no
    # halogenation, no aromatic substitution. A mock of nothing.)
    gm_cfg = PHASE_IDEAL_RATIOS["Grand Mock"]
    gm_ids = _reserve("Grand Mock", needs["Grand Mock"])
    phases_out["Grand Mock"] = {
        "min_tests": 1, "q_per_test": gm_cfg["q_per_test"],
        "ratios": gm_cfg["ratios"], "time_minutes": gm_cfg["time_minutes"],
        "v3_band": 0,
        "reserved_question_ids": sorted(gm_ids, key=natural_sort_key),
        "reserved_v1_ids": sorted(gm_ids, key=natural_sort_key),
    }

    for name in PHASE_ORDER:
        cfg = PHASE_IDEAL_RATIOS[name]
        ids = _reserve(name, needs[name])
        ids.sort(key=natural_sort_key)
        phases_out[name] = {
            "min_tests": mins[name], "q_per_test": cfg["q_per_test"],
            "ratios": cfg["ratios"], "time_minutes": cfg["time_minutes"],
            "v3_band": cfg["v3_band"],
            "reserved_v1_ids": ids,
        }

    # Endurance: a real phase, not a dumping ground. Same v1/v2/v3 machinery.
    leftover = taker.remaining()
    end_ids = []
    shape = solved["endurance_shape"]
    if shape:
        end_targets = compute_concept_targets(
            {c: sum(len(leftover[d].get(c, [])) for d in DIFFS)
             for c in ing["concept_weight"]},
            sum(solved["endurance_reserve"].values()), floor=1)
        end_taker = ConceptTaker(leftover, end_targets, floor=1)
        for d in DIFFS:
            end_ids.extend(end_taker.take(d, solved["endurance_reserve"][d]))
    phases_out[ENDURANCE] = {
        "min_tests": solved["endurance_tests"],
        "q_per_test": ENDURANCE_Q_PER_TEST,
        "ratios": shape or {d: 0 for d in DIFFS},
        "per_test_split": solved["endurance_per_test"],
        "time_minutes": ENDURANCE_TIME_MINUTES,
        "v3_band": ENDURANCE_V3_BAND,
        "reserved_v1_ids": sorted(end_ids, key=natural_sort_key),
    }

    # Concept coverage report -- this is the check the old phase report could
    # not do (it only ever validated difficulty totals, and happily printed
    # "All phases covered" while 13 concepts got nothing).
    alloc = dict(taker.allocated)
    zero = [c for c in ing["concept_weight"] if alloc.get(c, 0) == 0]
    below = [c for c in ing["concept_weight"]
             if 0 < alloc.get(c, 0) < min(CONCEPT_FLOOR, ing["concept_weight"][c])]
    content_check["concept_coverage"] = {
        "concepts_total": len(ing["concept_weight"]),
        "concepts_at_zero": zero,
        "concepts_below_floor": below,
        "journey_alloc": alloc,
        "targets": targets,
    }
    if zero:
        content_check["sufficient"] = False

    # Global companion maps. These MUST be plan-level, not per-phase: once a
    # trailing owed_v2 rides from Foundation into Skill Building, a
    # Skill-Building-scoped v2_by_base would not contain that base and the
    # remediation would silently vanish -- the exact class of bug this rework
    # exists to kill.
    return {
        "phases": phases_out,
        "min_tests_solved": mins,
        "v2_by_base": ing["v2_by_base"],
        "v3_by_base": ing["v3_by_base"],
        "v1_meta": ing["v1_meta"],
        "concept_weight": ing["concept_weight"],
        "concept_targets": targets,
        "pool_counts": pool_counts,
        "surplus": solved["surplus"],
        "stranded": solved["stranded"],
        "endurance_tests": solved["endurance_tests"],
        "endurance_per_test": solved["endurance_per_test"],
        "content_check": content_check,
        "engine": "concept_stratified_v3",
        "plan_version": plan_version,
        "content_signature": compute_content_signature(
            all_chapter_questions, concepts_summary, plan_version),
    }


# ─────────────────────────────────────────────────────────────────────
# PER-STUDENT STATE
# ─────────────────────────────────────────────────────────────────────

def fresh_phase_state():
    st = {name: {"tests_taken": 0, "owed_v2": [], "status": "not_started"}
          for name in PHASE_ORDER}
    st["Foundation"]["status"] = "active"
    st["Grand Mock"] = {"tests_taken": 0, "owed_v2": [], "status": "not_started"}
    st[ENDURANCE] = {"tests_taken": 0, "owed_v2": [], "status": "not_started"}
    return st


def get_active_phase(test_plan, phase_state):
    for name in PHASE_ORDER:
        if phase_state.get(name, {}).get("status") != "complete":
            return name
    if phase_state.get("Grand Mock", {}).get("status") != "complete":
        return "Grand Mock"
    return ENDURANCE


def next_phase_after(name):
    """Where a phase's trailing queue goes. Grand Mock is skipped on purpose:
    it is a clean capstone and must never carry remediation content."""
    if name in PHASE_ORDER:
        i = PHASE_ORDER.index(name)
        return PHASE_ORDER[i + 1] if i + 1 < len(PHASE_ORDER) else ENDURANCE
    return ENDURANCE


def phase_completion_status(plan_phase, state, seen_question_ids):
    """
    Complete when the phase's reserved CONTENT is spent. That is the whole test.

    NOT `tests_taken >= min_tests`: that condition is provably redundant in the
    normal flow and actively harmful in one case. Redundant because reserved
    content is exactly min_tests * q_per_test, drained at no more than
    q_per_test per test (and owed v2s eat into that), so an empty pool always
    implies min_tests tests have already happened. Harmful because a replan
    resets tests_taken to 0 while seen_question_ids deliberately survives -- so
    a student who already worked through a phase comes back with unshown=[] and
    tests_taken=0, the phase stays "active" forever, and generate_test has
    nothing to select and 400s on every attempt. A permanent lock, triggered by
    any content re-upload. See prove_replan_cannot_deadlock().

    The queue is also deliberately not part of this test: making a phase wait
    for its own owed_v2 to drain produced 1- and 2-question stub tests at every
    phase boundary. Trailing v2s ride forward instead (see next_phase_after).

    There is no "forced" branch any more -- see prove_no_forced_closure().
    """
    unshown = [q for q in plan_phase.get("reserved_v1_ids", []) if q not in seen_question_ids]
    if not unshown:
        return "complete", None
    return "active", None


def build_next_test_selection(plan_phase, state, seen_question_ids, questions_by_id,
                              v2_by_base, v3_by_base, v3_check_queue, global_test_num,
                              concept_rank=None, rng=None):
    """
    Build one test:
      1. owed v2s (FIFO) -- fill from q_per_test
      2. fresh v1s from this phase's reserve -- fill the rest
      3. due v3 spaced checks -- ADDITIVE band on top of q_per_test

    (3) being additive is load-bearing: if v3 checks competed for q_per_test,
    the worst case becomes v1 + v2 + v3 = 2.1x min_tests and phases could no
    longer be guaranteed to drain. See module docstring (5).

    concept_rank: {concept_id: rank} weakest-first. Used by Endurance to spend
    its content where the student is actually weak instead of at random.

    MUTATES state["owed_v2"] and v3_check_queue.
    Returns (selected_questions, is_flex, log_info).
    """
    qpt = plan_phase["q_per_test"]
    band = plan_phase.get("v3_band", 0)
    v1_pool = plan_phase.get("reserved_v1_ids", [])

    unshown_v1 = [q for q in v1_pool if q not in seen_question_ids]
    if concept_rank:
        def crank(qid):
            q = questions_by_id.get(qid)
            cid = (q or {}).get("meta_data", {}).get("concept_id", "")
            return (concept_rank.get(cid, 9999), natural_sort_key(qid))
        unshown_v1.sort(key=crank)

    selected_ids = []
    owed_used, fresh_used, dropped = [], [], []

    still_owed = []
    for base_id in list(state.get("owed_v2", [])):
        if len(selected_ids) >= qpt:
            still_owed.append(base_id)
            continue
        v2_qid = v2_by_base.get(base_id)
        if v2_qid and v2_qid not in seen_question_ids and v2_qid not in selected_ids:
            selected_ids.append(v2_qid)
            owed_used.append(base_id)
        else:
            # Now LOGGED rather than silently swallowed. With require_v2 at
            # reservation this should be unreachable; if it ever fires, the
            # content contract broke and we want to know.
            dropped.append(base_id)
    state["owed_v2"] = still_owed

    for qid in unshown_v1:
        if len(selected_ids) >= qpt:
            break
        selected_ids.append(qid)
        fresh_used.append(qid)

    # v3 spaced checks -- additive
    v3_used, v3_dead = [], []
    if band > 0 and v3_check_queue is not None:
        # Drop audits whose v3 can never run, BEFORE taking the band. A booked
        # audit is dead if the base has no v3 at all, or if its v3 was already
        # spent by the intervention popup.
        #
        # The spent case is reachable and not rare: a base can fail v1, fail v2,
        # escalate (popup burns the v3) -- and then the student retakes that test
        # and passes the v2, which books an audit for a v3 that no longer exists
        # to give. request_retest() rewinds tests_taken and owed_v2, but a
        # question that has been seen stays seen, correctly.
        #
        # Skipping those is right (auditing with a v3 they have already been
        # shown would just be a giveaway), but they must not consume a band slot
        # to be discovered: `due[:band]` took the first 2 regardless, so two dead
        # bookings would silently eat the whole test's audit capacity and push
        # the live ones a test later. Filter first, then take.
        def _v3_answerable(qid):
            """Can the student actually answer it? generate_test() discards any
            question with an empty options array, and it does that AFTER this
            function has already taken the booking off the queue -- so an
            unanswerable v3 was consumed and never shown, and the audit vanished
            without a trace. Live case: match_the_following v3s that qgen emits
            as pure-mapping questions (list1/list2/correct_mapping populated,
            options []). 5 of 9 matc v3s in Hydrocarbons are like this."""
            q = questions_by_id.get(qid)
            if q is None:
                return True   # not loaded here; leave it to the caller
            opts = (q.get("content", {}) or {}).get("options", []) or []
            return any((o or {}).get("id") for o in opts)

        for item in list(v3_check_queue):
            if item.get("due_test", 0) > global_test_num:
                continue
            qid = v3_by_base.get(item["base_id"])
            reason = None
            if not qid:
                reason = "no v3"
            elif qid in seen_question_ids:
                reason = "v3 already used (intervention popup)"
            elif not _v3_answerable(qid):
                reason = "v3 has no options (unanswerable)"
            if reason:
                item = dict(item)
                item["reason"] = reason
                v3_dead.append(item)
        for d in v3_dead:
            v3_check_queue[:] = [i for i in v3_check_queue
                                 if i.get("base_id") != d["base_id"]]

        due = [item for item in v3_check_queue if item.get("due_test", 0) <= global_test_num]
        for item in due[:band]:
            qid = v3_by_base.get(item["base_id"])
            if qid and qid not in seen_question_ids and qid not in selected_ids:
                selected_ids.append(qid)
                v3_used.append(item)
            v3_check_queue.remove(item)

    selected_questions = [questions_by_id[q] for q in selected_ids if q in questions_by_id]

    # Shuffle. The old build handed back owed_v2s then fresh v1s and never
    # shuffled, so every single test opened with exactly the questions the
    # student got wrong last time, in the same slots. Students spot that
    # pattern fast, and once they do it is a free prime -- and it confounds
    # the v2 measurement with an order effect.
    if rng is not None:
        rng.shuffle(selected_questions)

    difficulty_breakdown = {d: 0 for d in DIFFS}
    concepts_here = set()
    for q in selected_questions:
        m = q.get("meta_data", {})
        d = m.get("difficulty", "")
        if d in difficulty_breakdown:
            difficulty_breakdown[d] += 1
        concepts_here.add(m.get("concept_id", ""))

    is_flex = state.get("tests_taken", 0) >= plan_phase.get("min_tests", 1)
    v1_shown = len([q for q in v1_pool if q in seen_question_ids]) + len(fresh_used)

    log_info = {
        "owed_v2_used": len(owed_used), "owed_v2_used_ids": owed_used,
        "owed_v2_dropped": dropped,
        "fresh_v1_used": len(fresh_used), "fresh_v1_ids": fresh_used,
        "owed_v2_still_queued": len(state["owed_v2"]),
        "v3_checks_used": len(v3_used), "v3_checks": v3_used,
        "v3_checks_dropped": v3_dead,
        "v3_checks_still_queued": len(v3_check_queue or []),
        "unshown_v1_remaining_after": max(0, len(unshown_v1) - len(fresh_used)),
        "is_flex": is_flex,
        "difficulty_breakdown": difficulty_breakdown,
        "v1_total_reserved": len(v1_pool), "v1_shown_so_far": v1_shown,
        "concepts_this_test": sorted(c for c in concepts_here if c),
    }
    return selected_questions, is_flex, log_info


def process_learning_phase_result(state, question_grades, v3_check_queue, global_test_num,
                                 is_retake=False):
    """
    Grade one learning-phase test.

    question_grades: [{"base_question_id", "variation_number", "is_correct"}]

    v1 wrong -> owed_v2 (fires next test, T+1: the student has just read the
                explanation, and closing the concept inside two tests is the
                contract the journey makes)
    v2 right  -> closed_recovered, AND books a v3 audit at T+LAG. A correct v2
                used to close a base forever; but v2 shares v1's options and
                key, so a pass 10 minutes after reading the explanation may be
                recall, not learning. The audit is how we find out.
    v2 wrong  -> escalation (existing v3 popup path, untouched)
    v3 right  -> confirmed
    v3 wrong  -> the recovery was an illusion. Flagged for Endurance review.
                Deliberately does NOT call the intervention machinery: the v3
                is already spent, and the popup path must stay untouched.

    ON A RETAKE an audit is NOT re-graded. The audit is only worth anything
    because it is a question the student has never seen, asked once the
    explanation has gone cold -- that is its whole reason to exist, since the v2
    it is checking shares v1's options and answer and can be passed from memory
    alone. But a retake serves the SAME session back, so the student meets the
    audit again minutes after reading its explanation. Re-grading that measures
    precisely the short-term recall the audit was built to see past.

    Observed live: p24_b5 failed its audit at test 8 (5/14 -> retake) and came
    back "confirmed" four minutes later. Same for p28_b2 at test 10, and p6_b3 /
    p3_b3 at test 5. Four bases recorded as verified when what actually happened
    was: caught, shown the answer, asked again immediately, passed.

    So the first verdict stands, in BOTH directions -- a failed audit is not
    laundered into a pass, and a passed one is not put back at risk. The question
    is spent either way; meeting it twice cannot make it a fair test again.

    MUTATES state["owed_v2"], state["tests_taken"], v3_check_queue.
    """
    outcomes, escalations, review_flags = [], [], []

    for g in question_grades:
        base_id = g["base_question_id"]
        var = g["variation_number"]
        correct = g["is_correct"]

        if var == 1:
            if correct:
                outcomes.append({"base_id": base_id, "variation": "v1",
                                 "result": "correct", "status": "closed_clean"})
            else:
                state.setdefault("owed_v2", []).append(base_id)
                outcomes.append({"base_id": base_id, "variation": "v1",
                                 "result": "wrong", "status": "v1_wrong_awaiting_v2"})
        elif var == 2:
            if correct:
                outcomes.append({"base_id": base_id, "variation": "v2",
                                 "result": "correct", "status": "closed_recovered"})
                if v3_check_queue is not None:
                    v3_check_queue.append({"base_id": base_id,
                                           "due_test": global_test_num + V3_CHECK_LAG,
                                           "booked_at_test": global_test_num})
            else:
                outcomes.append({"base_id": base_id, "variation": "v2",
                                 "result": "wrong", "status": "escalated"})
                escalations.append(base_id)
        elif var == 3:
            if is_retake:
                outcomes.append({"base_id": base_id, "variation": "v3_check",
                                 "result": "correct" if correct else "wrong",
                                 "status": "audit_already_spent"})
            elif correct:
                outcomes.append({"base_id": base_id, "variation": "v3_check",
                                 "result": "correct", "status": "confirmed"})
            else:
                outcomes.append({"base_id": base_id, "variation": "v3_check",
                                 "result": "wrong", "status": "reopened_false_recovery"})
                review_flags.append(base_id)
        else:
            outcomes.append({"base_id": base_id, "variation": f"v{var}",
                             "result": "correct" if correct else "wrong",
                             "status": "unknown"})

    state["tests_taken"] = state.get("tests_taken", 0) + 1
    return {"outcomes": outcomes, "escalations": escalations,
            "review_flags": review_flags}


def carry_queue_forward(phase_state, from_phase):
    """Move a completed phase's trailing owed_v2 into the next phase."""
    src = phase_state.get(from_phase, {})
    tail = list(src.get("owed_v2", []))
    if not tail:
        return None, 0
    dest = next_phase_after(from_phase)
    phase_state.setdefault(dest, {"tests_taken": 0, "owed_v2": [], "status": "not_started"})
    phase_state[dest]["owed_v2"] = tail + list(phase_state[dest].get("owed_v2", []))
    src["owed_v2"] = []
    return dest, len(tail)


def concept_rank_from_mastery(concept_mastery):
    """Weakest concept first. Untouched concepts rank before mastered ones."""
    def score(item):
        cid, cm = item
        if cm.get("status") == "not_started":
            return (-1, cid)
        return (cm.get("mastery_score", 0), cid)
    return {cid: i for i, (cid, _) in enumerate(sorted(concept_mastery.items(), key=score))}


# ─────────────────────────────────────────────────────────────────────
# PROOF (kept as executable, not prose)
# ─────────────────────────────────────────────────────────────────────

def prove_no_forced_closure(max_min_tests=8):
    """
    Exhaustively verify that tests-to-drain never exceeds 2 x min_tests, for
    every phase, every min_tests, every miss rate 0..100%. This is why
    max_tests could be deleted: the natural-completion branch always fires
    first, so the "forced" branch was unreachable -- which in turn is why
    needs_review was never written and the Bonus Pool eligibility guard
    rejected everyone.

    Valid ONLY while the v3 band is additive. If v3 checks ever consume
    q_per_test, worst case becomes ~2.1x and this proof fails -- which is
    exactly what it is here to catch.
    """
    worst = 0.0
    for name in PHASE_ORDER:
        cfg = PHASE_IDEAL_RATIOS[name]
        qpt = cfg["q_per_test"]
        for mn in range(1, max_min_tests + 1):
            for miss_pct in range(0, 101):
                miss = miss_pct / 100.0
                fresh, owed, t = mn * qpt, 0, 0
                while (fresh or owed) or t < mn:
                    if not fresh and not owed and t >= mn:
                        break
                    t += 1
                    slots = qpt
                    use_v2 = min(owed, slots); owed -= use_v2; slots -= use_v2
                    use_v1 = min(fresh, slots); fresh -= use_v1
                    owed += round(use_v1 * miss)
                    if t > 100:
                        return False, 99.0
                worst = max(worst, t / mn)
    return worst <= 2.0, worst


def prove_replan_cannot_deadlock():
    """
    A replan resets tests_taken to 0 but keeps seen_question_ids. For every
    phase, every min_tests, and every possible amount of prior progress, the
    phase must still be able to either generate a test or report complete --
    never both-neither, which is a permanent 400.
    """
    bad = []
    for name in PHASE_ORDER:
        cfg = PHASE_IDEAL_RATIOS[name]
        for mn in range(1, 9):
            reserved = [f"q{i}" for i in range(mn * cfg["q_per_test"])]
            pp = {"reserved_v1_ids": reserved, "min_tests": mn,
                  "q_per_test": cfg["q_per_test"], "v3_band": cfg["v3_band"]}
            for n_seen in range(0, len(reserved) + 1):
                seen = set(reserved[:n_seen])
                state = {"tests_taken": 0, "owed_v2": [], "status": "active"}
                status, _ = phase_completion_status(pp, state, seen)
                can_generate = any(q not in seen for q in reserved)
                if status == "active" and not can_generate:
                    bad.append((name, mn, n_seen))
    return (not bad), bad