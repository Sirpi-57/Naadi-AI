"""Verification suite. Run: python3 test_engine_verify.py"""
import random, sys
from collections import defaultdict
import opd_engine as E

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"   [{detail}]" if detail else ""))


# ── synthetic chapter builder matching the real qgen shape ──
def make_chapter(concept_blocks, diff_mix, seed=1, v2_drop=0.0):
    """concept_blocks: {concept_id: [block_ids]}; diff_mix: (E,M,H) weights."""
    rng = random.Random(seed)
    qs = []
    for cid, blocks in concept_blocks.items():
        for b in blocks:
            for ang in range(1, 3):
                for k in range(1, 3):
                    d = rng.choices(E.DIFFS, weights=diff_mix)[0]
                    base = f"{b}_ANG_{ang}_{d[0]}_x{k}"
                    for var, pool in ((1, "regular"), (2, "regular"), (3, "intervention_reserve")):
                        if var == 2 and rng.random() < v2_drop:
                            continue
                        qs.append({
                            "question_id": f"{base}_v{var}",
                            "content": {"options": [{"id": "A", "is_correct": True},
                                                    {"id": "B", "is_correct": False}],
                                        "question_text": "q"},
                            "meta_data": {"chapter_id": "CH", "pool": pool,
                                          "variation_number": var, "difficulty": d,
                                          "base_question_id": base, "concept_id": cid,
                                          "concept_name": cid},
                        })
    return qs


HYDRO_BLOCKS = {
    "C01": ["p1_b1", "p2_b2", "p2_b3"],
    "C02": [f"p{p}_b{b}" for p, b in [(3,1),(3,2),(3,3),(4,1),(5,1),(5,2),(5,3),(5,4),(5,5),(5,6),(6,1)]],
    "C03": ["p4_b2", "p4_b3"],
    "C04": ["p2_b4", "p2_b5", "p3_b4"],
    "C05": ["p11_b1","p11_b2","p11_b3","p11_b4","p11_b5","p12_b1","p12_b2"],
    "C06": ["p10_b9","p6_b2","p6_b3","p6_b4","p6_b5","p6_b6"],
    "C07": [f"p{p}_b{b}" for p,b in [(12,3),(12,4),(12,5),(12,6),(12,7),(12,8),(13,1),(13,2),(13,3),(13,4),(13,5),(14,1),(14,2),(14,3),(14,4),(14,5)]],
    "C08": ["p14_b6","p14_b7","p15_b1","p15_b2","p15_b3"],
    "C09": ["p16_b6"],
    "C10": ["p15_b4","p15_b5","p16_b1","p16_b2","p16_b3","p16_b4","p16_b5"],
    "C11": [f"p17_b{i}" for i in range(1,16)] + ["p16_b7","p16_b8","p16_b9","p19_b1","p19_b2","p19_b3","p19_b4","p33_b11"],
    "C12": ["p19_b5","p19_b6","p19_b7","p19_b8","p19_b9","p19_b10"],
    "C13": ["p19_b11","p19_b12","p19_b13","p33_b1","p33_b2","p33_b3","p33_b12"],
    "C14": ["p19_b14","p20_b1","p20_b2","p20_b3","p20_b4"],
    "C15": ["p20_b5","p20_b6","p20_b7","p20_b8","p20_b9","p21_b1","p21_b2"],
    "C16": ["p21_b3","p21_b4","p21_b5"],
    "C17": ["p21_b6","p21_b7","p21_b8","p21_b9","p33_b13"],
    "C18": ["p21_b10"] + [f"p23_b{i}" for i in range(1,12)] + ["p24_b1","p24_b2"],
    "C19": ["p24_b3","p24_b5","p25_b1","p25_b2","p25_b3","p25_b4","p27_b6","p28_b1"],
    "C20": ["p26_b1","p26_b2","p26_b4","p26_b5","p27_b1","p27_b2","p27_b3","p27_b4","p27_b5","p33_b6","p33_b7","p33_b8"],
    "C21": [f"p28_b{i}" for i in range(3,11)] + [f"p29_b{i}" for i in range(1,8)] + [f"p31_b{i}" for i in range(1,6)] + ["p33_b14"],
    "C22": ["p30_b1","p30_b2"],
    "C23": [f"p9_b{i}" for i in range(1,9)],
    "C24": ["p10_b1","p30_b3","p30_b4","p33_b4","p9_b9","p9_b10","p9_b11"],
    "C25": ["p10_b2","p10_b3","p10_b4","p10_b5"],
    "C26": ["p10_b6","p10_b7","p10_b8","p10_b10","p10_b11","p10_b12"],
    "C27": ["p31_b6"], "C28": ["p28_b2","p32_b1"], "C29": ["p33_b9"], "C30": ["p33_b5","p33_b10"],
}

print("\n" + "="*74); print("1. UNIT"); print("="*74)

check("largest_remainder sums exactly (GM 25 -> 5/13/7)",
      E.largest_remainder_split(25, {"Easy":.2,"Medium":.5,"Hard":.3}) == {"Easy":5,"Medium":13,"Hard":7})
check("largest_remainder Mastery 15 -> 4/8/3",
      E.largest_remainder_split(15, {"Easy":.3,"Medium":.5,"Hard":.2}) == {"Easy":4,"Medium":8,"Hard":3})

nat = sorted(["p10_b1_x","p3_b1_x","p9_b1_x","p2_b1_x","p33_b1_x"], key=E.natural_sort_key)
check("natural sort: p2 < p3 < p9 < p10 < p33", nat == ["p2_b1_x","p3_b1_x","p9_b1_x","p10_b1_x","p33_b1_x"], str(nat))
check("lexicographic sort was broken (p3 > p29)", "p3_b1" > "p29_b1")

check("_normalize_base_id strips _v1", E._normalize_base_id("p1_b1_ANG_1_E_exce_v1") == "p1_b1_ANG_1_E_exce")
check("_normalize_base_id keeps _x gap-fill", E._normalize_base_id("p9_b6_ANG_1_M_nume_v2_x2") == "p9_b6_ANG_1_M_nume_x2")

ok, worst = E.prove_no_forced_closure()
check("max_tests proof: tests/min_tests <= 2.0 always", ok, f"worst={worst:.2f}")

ok2, bad = E.prove_replan_cannot_deadlock()
check("replan proof: never active-with-nothing-to-generate", ok2, str(bad[:3]))

# An unanswerable v1 is a permanent deadlock: reserved, dropped at render,
# never seen, phase never completes, re-selected every test forever.
_bad_v1 = [
 {'question_id':'X_v1','content':{'options':[]},
  'meta_data':{'pool':'regular','variation_number':1,'difficulty':'Easy',
               'base_question_id':'X','concept_id':'C1'}},
 {'question_id':'X_v2','content':{'options':[{'id':'A','is_correct':True}]},
  'meta_data':{'pool':'regular','variation_number':2,'difficulty':'Easy',
               'base_question_id':'X','concept_id':'C1'}},
 {'question_id':'Y_v1','content':{'options':[{'id':'A','is_correct':True}]},
  'meta_data':{'pool':'regular','variation_number':1,'difficulty':'Easy',
               'base_question_id':'Y','concept_id':'C1'}},
 {'question_id':'Y_v2','content':{'options':[{'id':'A','is_correct':True}]},
  'meta_data':{'pool':'regular','variation_number':2,'difficulty':'Easy',
               'base_question_id':'Y','concept_id':'C1'}},
]
_i = E.ingest_questions(_bad_v1)
check("unanswerable v1 excluded (would deadlock phase)",
      _i['unanswerable_v1'] == ['X_v1'], str(_i['unanswerable_v1']))
check("answerable v1 still reserved", _i['v1_by_diff_concept']['Easy'] == {'C1': ['Y_v1']},
      str(_i['v1_by_diff_concept']['Easy']))

# v2 present but unanswerable -> its v1 is an orphan, not a landmine
_bad_v2 = [
 {'question_id':'Z_v1','content':{'options':[{'id':'A','is_correct':True}]},
  'meta_data':{'pool':'regular','variation_number':1,'difficulty':'Easy',
               'base_question_id':'Z','concept_id':'C1'}},
 {'question_id':'Z_v2','content':{'options':[]},
  'meta_data':{'pool':'regular','variation_number':2,'difficulty':'Easy',
               'base_question_id':'Z','concept_id':'C1'}},
]
_j = E.ingest_questions(_bad_v2)
check("v1 whose v2 is unanswerable -> orphan", _j['orphans'] == ['Z_v1'], str(_j['orphans']))

# A dead audit (v3 already spent by the intervention popup, e.g. after a retake)
# must not consume a band slot -- the live audits behind it would be pushed back
# a test for nothing.
# NOTE: content.options is required on these fixtures. build_next_test_selection
# now mirrors generate_test's `if not options: continue` when deciding whether an
# audit can run, so a fixture with no content reads as unanswerable -- correctly.
_OPT = {'options': [{'id': 'A', 'is_correct': True}, {'id': 'B', 'is_correct': False}]}
_qbi = {'A_v3': {'question_id':'A_v3','content':dict(_OPT),'meta_data':{'difficulty':'Easy','concept_id':'C','variation_number':3}},
        'B_v3': {'question_id':'B_v3','content':dict(_OPT),'meta_data':{'difficulty':'Easy','concept_id':'C','variation_number':3}},
        'C_v3': {'question_id':'C_v3','content':dict(_OPT),'meta_data':{'difficulty':'Easy','concept_id':'C','variation_number':3}}}
_pp = {'reserved_v1_ids': [], 'q_per_test': 10, 'min_tests': 1, 'v3_band': 2}
_st = {'tests_taken': 1, 'owed_v2': []}
_q  = [{'base_id':'A','due_test':5}, {'base_id':'B','due_test':5}, {'base_id':'C','due_test':5}]
_sel, _, _lg = E.build_next_test_selection(
    _pp, _st, {'A_v3'},            # A's v3 already SEEN (popup burned it)
    _qbi, {}, {'A':'A_v3','B':'B_v3','C':'C_v3'}, _q, 5)
check("dead audit dropped, not counted against the band",
      len(_lg['v3_checks_used']) == 2 if isinstance(_lg['v3_checks_used'], list) else _lg['v3_checks_used'] == 2,
      f"used={_lg['v3_checks_used']} dropped={[d['base_id'] for d in _lg['v3_checks_dropped']]}")
check("the spent v3 is reported, not silent",
      [d['base_id'] for d in _lg['v3_checks_dropped']] == ['A'], str(_lg['v3_checks_dropped']))
# An UNANSWERABLE v3 (options []) must be dropped too. generate_test() discards
# it at render, but the booking has already left the queue by then -- so the
# audit was consumed and never shown. Real case: Test 6 built 14 questions and
# shipped 13; the missing one was p9_b2_ANG_1_E_matc_v3, options [].
_qbi2 = {'A_v3': {'question_id':'A_v3','content':{'options':[]},                     # unanswerable
                  'meta_data':{'difficulty':'Easy','concept_id':'C','variation_number':3}},
         'B_v3': {'question_id':'B_v3','content':{'options':[{'id':'A','is_correct':True}]},
                  'meta_data':{'difficulty':'Easy','concept_id':'C','variation_number':3}}}
_pp2 = {'reserved_v1_ids': [], 'q_per_test': 10, 'min_tests': 1, 'v3_band': 2}
_q2  = [{'base_id':'A','due_test':5}, {'base_id':'B','due_test':5}]
_sel2, _, _lg2 = E.build_next_test_selection(
    _pp2, {'tests_taken':1,'owed_v2':[]}, set(), _qbi2, {},
    {'A':'A_v3','B':'B_v3'}, _q2, 5)
check("unanswerable v3 audit dropped, not silently eaten",
      [d['base_id'] for d in _lg2['v3_checks_dropped']] == ['A'], str(_lg2['v3_checks_dropped']))
check("its reason is reported",
      _lg2['v3_checks_dropped'][0]['reason'] == 'v3 has no options (unanswerable)',
      str(_lg2['v3_checks_dropped'][0]))
check("the answerable audit still fired",
      [q['question_id'] for q in _sel2] == ['B_v3'], str([q['question_id'] for q in _sel2]))

check("live audits B and C both fired",
      sorted(q['question_id'] for q in _sel) == ['B_v3','C_v3'],
      str([q['question_id'] for q in _sel]))
check("unanswerable v2 reported", _j['unanswerable_v2'] == ['Z_v2'], str(_j['unanswerable_v2']))

t = E.compute_concept_targets({"a":50,"b":50,"c":2}, 60)
check("concept targets: floor honoured for tiny concept", t["c"] >= 2, str(t))
check("concept targets: sum <= budget", sum(t.values()) <= 60, str(t))
check("concept targets: big concepts get more", t["a"] > t["c"], str(t))
t2 = E.compute_concept_targets({"a":1}, 100)
check("concept targets never exceed availability", t2["a"] == 1, str(t2))

print("\n" + "="*74); print("2. SOLVER vs REAL CHAPTER POOLS"); print("="*74)
REAL = {
    "Small A":      {"Easy": 71,  "Medium": 182, "Hard": 105},
    "Small B":      {"Easy": 78,  "Medium": 138, "Hard": 63},
    "Big C":        {"Easy": 118, "Medium": 319, "Hard": 192},
    "Hydrocarbons": {"Easy": 122, "Medium": 338, "Hard": 195},
}
EXPECT = {"Small A": (3,3,3,7), "Small B": (3,3,3,5), "Big C": (8,3,3,8), "Hydrocarbons": (4,4,4,7)}
print(f"  {'chapter':<14}{'config':>10}{'jrnyV1':>8}{'strand':>8}{'End':>5}")
for nm, pool in REAL.items():
    s = E.solve_min_tests(pool)
    m = s["mins"]
    tag = (m["Foundation"], m["Skill Building"], m["Mastery"], m["NEET Simulation"])
    print(f"  {nm:<14}{'/'.join(map(str,tag)):>10}{s['journey_v1']:>8}{s['stranded']:>8}{s['endurance_tests']:>5}")
    check(f"solver {nm} -> {'/'.join(map(str,EXPECT[nm]))}", tag == EXPECT[nm], f"got {tag}")
    check(f"solver {nm}: strand small", s["stranded"] <= 10, f"strand={s['stranded']}")

print("\n" + "="*74); print("3. HYDROCARBONS PLAN"); print("="*74)
qs = make_chapter(HYDRO_BLOCKS, (25, 45, 30), seed=7)
plan = E.calculate_dynamic_test_plan(qs, [{"concept_id": c} for c in HYDRO_BLOCKS])
cc = plan["content_check"]["concept_coverage"]
print(f"  pool {plan['pool_counts']} | journey v1 "
      f"{sum(len(plan['phases'][p]['reserved_v1_ids']) for p in E.JOURNEY_ORDER)} "
      f"| solved {plan['min_tests_solved']}")
print(f"  concepts {cc['concepts_total']} | at zero {len(cc['concepts_at_zero'])} "
      f"| below floor {len(cc['concepts_below_floor'])} | stranded {plan['stranded']}")
check("Hydrocarbons: 0 concepts at zero", len(cc["concepts_at_zero"]) == 0, str(cc["concepts_at_zero"]))
check("Hydrocarbons: 0 concepts below floor", len(cc["concepts_below_floor"]) == 0, str(cc["concepts_below_floor"]))

gm = plan["phases"]["Grand Mock"]["reserved_v1_ids"]
gm_concepts = {plan["v1_meta"][q]["concept"] for q in gm}
check("Grand Mock is exactly 25Q", len(gm) == 25, f"got {len(gm)}")
print(f"  Grand Mock covers {len(gm_concepts)}/{cc['concepts_total']} concepts")
check("Grand Mock spans >=20 concepts (was front-of-chapter only)", len(gm_concepts) >= 20, f"{len(gm_concepts)}")

allq = set()
for p in E.FULL_ORDER:
    ids = plan["phases"][p]["reserved_v1_ids"]
    check(f"no duplicate reservation in {p}", len(ids) == len(set(ids)))
    check(f"no cross-phase overlap at {p}", not (set(ids) & allq))
    allq |= set(ids)

# The old allocator, reproduced, to confirm the bug this replaces
old_by_diff = defaultdict(list)
for q in qs:
    m = q["meta_data"]
    if m["pool"] == "regular" and m["variation_number"] == 1:
        old_by_diff[m["difficulty"]].append((q["question_id"], m["concept_id"]))
for d in old_by_diff: old_by_diff[d].sort()
old_alloc = set()
for d, n in [("Easy", 65), ("Medium", 91), ("Hard", 40)]:
    for qid, cid in old_by_diff[d][:n]: old_alloc.add(cid)
old_zero = len(HYDRO_BLOCKS) - len(old_alloc)
print(f"  OLD allocator on same content: {old_zero} concepts at zero")
check("new engine beats old on concept coverage", old_zero > 0 and len(cc["concepts_at_zero"]) == 0,
      f"old={old_zero} new=0")

print("\n" + "="*74); print("4. ORPHAN v1 (v2 rejected at approval)"); print("="*74)
qs_orph = make_chapter(HYDRO_BLOCKS, (25, 45, 30), seed=7, v2_drop=0.15)
plan_o = E.calculate_dynamic_test_plan(qs_orph, [{"concept_id": c} for c in HYDRO_BLOCKS])
n_orph = plan_o["content_check"]["orphan_v1_no_v2"]
print(f"  orphans detected & excluded: {n_orph}")
check("orphan v1s detected", n_orph > 0, f"{n_orph}")
for p in E.JOURNEY_ORDER:
    ids = plan_o["phases"][p]["reserved_v1_ids"]
    missing = [q for q in ids if plan_o["v1_meta"][q]["base"] not in plan_o["v2_by_base"]]
    check(f"every reserved v1 in {p} has a v2", not missing, f"{len(missing)} missing")

print("\n" + "="*74); print("5. FULL JOURNEY SIM (Hydrocarbons)"); print("="*74)
MISS = {"Easy": .20, "Medium": .35, "Hard": .45}
V2_REC, V3_PASS = .70, .80


def run_chapter(plan, qs, seed=3, verbose=False):
    rng = random.Random(seed)
    qbi = {q["question_id"]: q for q in qs}
    ps = E.fresh_phase_state()
    seen, v3q = set(), []
    g = 0
    stats = defaultdict(int)
    sizes, phase_tests = [], {}
    concepts_touched = set()
    for name in E.FULL_ORDER:
        pp = plan["phases"][name]
        t = 0
        while True:
            st, _ = E.phase_completion_status(pp, ps[name], seen)
            if st == "complete":
                break
            g += 1; t += 1
            sel, flex, li = E.build_next_test_selection(
                pp, ps[name], seen, qbi, plan["v2_by_base"], plan["v3_by_base"],
                v3q, g, rng=rng)
            if not sel:
                break
            sizes.append((name, g, len(sel)))
            grades = []
            for q in sel:
                m = q["meta_data"]
                seen.add(q["question_id"])
                concepts_touched.add(m["concept_id"])
                v = m["variation_number"]
                if v == 1: ok = rng.random() > MISS[m["difficulty"]]
                elif v == 2: ok = rng.random() < V2_REC
                else: ok = rng.random() < V3_PASS
                grades.append({"base_question_id": m["base_question_id"],
                               "variation_number": v, "is_correct": ok})
                stats[f"v{v}_shown"] += 1
                stats[f"v{v}_{'ok' if ok else 'bad'}"] += 1
            r = E.process_learning_phase_result(ps[name], grades, v3q, g)
            stats["escalations"] += len(r["escalations"])
            stats["reopened"] += len(r["review_flags"])
            if t > 80: break
        phase_tests[name] = t
        ps[name]["status"] = "complete"
        dest, n = E.carry_queue_forward(ps, name)
        if n and verbose: print(f"    carried {n} owed v2 from {name} -> {dest}")
    return dict(stats=stats, phase_tests=phase_tests, sizes=sizes, seen=seen,
                concepts_touched=concepts_touched, global_tests=g, v3q=v3q, ps=ps)

r = run_chapter(plan, qs, verbose=True)
jt = sum(r["phase_tests"][p] for p in E.JOURNEY_ORDER)
print(f"  journey tests {jt} | endurance {r['phase_tests'][E.ENDURANCE]} | total {r['global_tests']}")
print(f"  v1 {r['stats']['v1_shown']} | v2 {r['stats']['v2_shown']} | v3check {r['stats']['v3_shown']}")
print(f"  escalations {r['stats']['escalations']} | false recoveries caught {r['stats']['reopened']}")
check("all 30 concepts touched", len(r["concepts_touched"]) == 30, f"{len(r['concepts_touched'])}")
check("Grand Mock ran exactly once", r["phase_tests"]["Grand Mock"] == 1, str(r["phase_tests"]["Grand Mock"]))
gm_sizes = [s for s in r["sizes"] if s[0] == "Grand Mock"]
check("Grand Mock was exactly 25Q", gm_sizes and gm_sizes[0][2] == 25, str(gm_sizes))
stubs = [s for s in r["sizes"] if s[2] <= 3 and s[0] != E.ENDURANCE]
check("no stub tests (<=3Q) in journey", not stubs, str(stubs[:4]))
check("false recoveries were caught", r["stats"]["reopened"] > 0, str(r["stats"]["reopened"]))
check("endurance ran", r["phase_tests"][E.ENDURANCE] > 0, str(r["phase_tests"][E.ENDURANCE]))

used = len(r["seen"])
tot = len(qs)
print(f"  content used {used}/{tot} ({used/tot*100:.0f}%)")
v1_tot = sum(plan["pool_counts"].values())
v1_used = r["stats"]["v1_shown"]
print(f"  v1 used {v1_used}/{v1_tot} ({v1_used/v1_tot*100:.0f}%)")
check("v1 utilisation >= 90%", v1_used / v1_tot >= 0.90, f"{v1_used/v1_tot*100:.0f}%")

print("\n" + "="*74); print("6. MIN + MAX DATA CHAPTERS"); print("="*74)
SMALL = {c: HYDRO_BLOCKS[c][:1] for c in list(HYDRO_BLOCKS)[:12]}
BIG = {c: HYDRO_BLOCKS[c] * 2 for c in HYDRO_BLOCKS}
for nm, blocks, mix in [("MIN (12 concepts)", SMALL, (30, 45, 25)),
                        ("MAX (30 concepts x2)", BIG, (20, 50, 30))]:
    q2 = make_chapter(blocks, mix, seed=11)
    p2 = E.calculate_dynamic_test_plan(q2, [{"concept_id": c} for c in blocks])
    c2 = p2["content_check"]["concept_coverage"]
    r2 = run_chapter(p2, q2, seed=5)
    j2 = sum(r2["phase_tests"][p] for p in E.JOURNEY_ORDER)
    print(f"  {nm:<22} pool {sum(p2['pool_counts'].values()):>4} | solved "
          f"{'/'.join(str(p2['min_tests_solved'][p]) for p in E.PHASE_ORDER):>8} | "
          f"zero {len(c2['concepts_at_zero'])} | jrny {j2} | end {r2['phase_tests'][E.ENDURANCE]} "
          f"| strand {p2['stranded']}")
    check(f"{nm}: 0 concepts at zero", len(c2["concepts_at_zero"]) == 0, str(c2["concepts_at_zero"]))
    check(f"{nm}: GM exactly 25Q", len(p2["phases"]["Grand Mock"]["reserved_v1_ids"]) == 25)
    check(f"{nm}: all concepts touched", len(r2["concepts_touched"]) == len(blocks),
          f"{len(r2['concepts_touched'])}/{len(blocks)}")

print("\n" + "="*74); print("7. UNLOCK / ENDURANCE GATE"); print("="*74)
ps = E.fresh_phase_state()
for p in E.PHASE_ORDER: ps[p]["status"] = "complete"
ps["Grand Mock"]["status"] = "complete"
check("active phase after GM = Endurance", E.get_active_phase(plan, ps) == E.ENDURANCE,
      E.get_active_phase(plan, ps))
check("Endurance has reserved content", len(plan["phases"][E.ENDURANCE]["reserved_v1_ids"]) > 0,
      str(len(plan["phases"][E.ENDURANCE]["reserved_v1_ids"])))
check("tail: Simulation carries to Endurance, NOT Grand Mock",
      E.next_phase_after("NEET Simulation") == E.ENDURANCE)
check("tail: Foundation -> Skill Building", E.next_phase_after("Foundation") == "Skill Building")

cm = {"a": {"status": "struggling", "mastery_score": 20},
      "b": {"status": "mastered", "mastery_score": 95},
      "c": {"status": "not_started", "mastery_score": 0}}
cr = E.concept_rank_from_mastery(cm)
# An audit is a one-shot instrument. A retake re-serves the same session, so the
# student meets it again minutes after reading its explanation -- re-grading that
# measures the exact recall the audit exists to see past. Live: p24_b5 failed its
# audit at test 8 and came back "confirmed" four minutes later.
def _audit(correct, retake):
    st = {"tests_taken": 0, "owed_v2": []}
    q = [{"base_question_id": "B", "variation_number": 3, "is_correct": correct}]
    r = E.process_learning_phase_result(st, q, [], 9, is_retake=retake)
    return r["outcomes"][0]["status"], r["review_flags"]

check("fresh audit passed -> confirmed", _audit(True, False) == ("confirmed", []))
check("fresh audit failed -> flagged for review",
      _audit(False, False) == ("reopened_false_recovery", ["B"]))
check("RETAKE cannot launder a failed audit into a pass",
      _audit(True, True) == ("audit_already_spent", []), str(_audit(True, True)))
check("RETAKE cannot re-flag a passed audit either",
      _audit(False, True) == ("audit_already_spent", []), str(_audit(False, True)))

check("weakest-first ranking: not_started, then weak, then mastered",
      cr["c"] < cr["a"] < cr["b"], str(cr))

print("\n" + "="*74)
print(f"RESULT: {len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    for f in FAIL: print("  FAILED:", f)
print("="*74)
sys.exit(1 if FAIL else 0)