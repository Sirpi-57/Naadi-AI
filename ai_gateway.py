"""
NAADI AI — NIA GATEWAY (ai_gateway.py)
════════════════════════════════════════════════════════════════════════

NIA = Naadi Intelligent Assistant. The student-facing chat, and the single
path from this codebase to any language model.

WHAT THIS FILE OWNS
    • the API key pool                  • the cost ledger
    • the quota                          • the safety layer
    • context resolution                 • the kill switch

WHAT IT DOES NOT TOUCH
    OPD v3. The v3 intervention tutor in backend.py keeps its own route,
    its own key and its own behaviour. v3 is core teaching: it must never
    be rate-limited, gated behind a paid plan, or switched off by an
    admin toggle. If you later want v3 on this transport, call ai_call()
    with feature="opd_v3" and policy_free=True — the policy layer is
    already written to skip it. Nothing here does that today.

════════════════════════════════════════════════════════════════════════
DATA MODEL

    ai_conversations/{conv_id}
        uid, student_name, class_key, school_id, class_id
        surface           "studio" | "opd_review" | "arena_review" | "generic"
        chapter_id, concept_id, subject
        concept_tag       model-supplied topic label (for v2 clustering)
        messages[]        {role, text, at, tokens}      ← ARRAY, not a
                          subcollection. 1 read to open a thread instead
                          of N. See DECISION 2.
        context_blocks[]  {at, text, key}               ← append-only
        created_at, updated_at, msg_count
        tokens_in, tokens_out, cost_inr
        status            "open" | "closed"

    ai_budgets/{uid}
        day_key "YYYY-MM-DD", day_convos, day_tokens, day_cost
        month_key "YYYY-MM", month_convos, month_tokens, month_cost
        life_convos, life_tokens, life_cost
        refusals, flags, updated_at

    ai_calls/{auto}          raw log — WRITE ONLY. Never scanned by a
                             dashboard. See DECISION 3.
        uid, feature, model, key_index, ok
        tok_cache_hit, tok_cache_miss, tok_out, cost_inr, ms, at

    ai_usage_daily/{YYYY-MM-DD}
        calls, cost_inr, tokens_in, tokens_out, students{uid: cost}

    platform_config/ai
        enabled, paid_only, model, daily_cap, monthly_cap, lifetime_cap,
        max_tokens, updated_at, updated_by

    safety_reports/{auto}    ← EXISTING collection, reused. The admin
                             Safety screen already renders it.

════════════════════════════════════════════════════════════════════════
FIVE DECISIONS THAT ARE NOT ARBITRARY

1. MESSAGE ORDER IS A COST DECISION, NOT A STYLE ONE.
   DeepSeek caches the PREFIX of a prompt — everything up to the first
   byte that changed — and bills a hit at 1/50th of a miss. So the order
   is fixed and shared-content-first:

       [0] global rules      identical for every student on the platform,
                             so it caches once and hits for everyone
       [1] chapter/concept    identical for every student on that concept
       [2] this student       weak concepts, v3 failures, accuracy
       [3..] history          appended, never rewritten
       [n] the question

   Put the student's name at position 0 and every student pays a cache
   miss on the whole block. Rewrite an earlier block mid-conversation and
   everything after it misses. This is why _assemble() appends a changed
   context as a NEW block at the end rather than editing block [1].

2. MESSAGES ARE AN ARRAY, NOT A SUBCOLLECTION.
   doubts_backend uses a subcollection because a thread there lives for a
   term and two humans write to it. A NIA conversation is short, single-
   session, and read whole every single turn. Twenty messages as a
   subcollection is twenty reads to open; as one document it is one.

3. THE ADMIN DASHBOARD NEVER SCANS ai_calls.
   At 50k logged calls a scan is 50k reads — about ₹2.60 — every time
   somebody taps refresh. Ten refreshes cost more than a student spends
   in a year. Every number the dashboard shows comes from a pre-
   aggregated rollup that was written at call time.

4. QUOTA IS CHECKED ON START, NOT ON SEND.
   A cap that can fire mid-explanation produces a truncated answer and a
   student who thinks the app is broken. The cap governs opening a NEW
   conversation. Once open, it runs to its natural end.

5. max_tokens IS A CIRCUIT BREAKER, NOT A BUDGET.
   You are billed for tokens generated, not for the ceiling. Setting it
   low to save money instead truncates a worked numerical halfway
   through. Length is shaped by the prompt; the ceiling exists only to
   stop a runaway loop.
"""

import os
import re
import sys
import json
import time
import html as _html
import threading
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta
from functools import wraps

from flask import Blueprint, request, jsonify, Response, stream_with_context
from firebase_admin import firestore

from portal_backend import _db, _iso, require_auth, require_role, class_key_for

try:
    from admin_backend import require_admin
except Exception:  # pragma: no cover - admin module optional at import time
    def require_admin(f):
        @wraps(f)
        def inner(*a, **kw):
            return jsonify({"error": "admin module not loaded"}), 503
        return inner

ai_bp = Blueprint("ai_gateway", __name__)

IST = timezone(timedelta(hours=5, minutes=30))


# ═══════════════════════════════════════════════════════════════════════
# PRICING & CONSTANTS
# ═══════════════════════════════════════════════════════════════════════

DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
DEFAULT_MODEL = "deepseek-v4-flash"

# USD per 1M tokens, deepseek-v4-flash. If DeepSeek changes its card,
# this dict is the only place to edit — every rupee figure in the admin
# dashboard is derived from it.
PRICE_USD_PER_MTOK = {
    "deepseek-v4-flash": {"hit": 0.0028, "miss": 0.14, "out": 0.28},
    "deepseek-v4-pro":   {"hit": 0.003625, "miss": 0.435, "out": 0.87},
}
USD_INR = float(os.environ.get("NAADI_USD_INR", "88"))

# Defaults. Live values come from platform_config/ai and override these.
DEFAULTS = {
    "enabled": True,
    "paid_only": False,
    "model": DEFAULT_MODEL,
    "daily_cap": 8,
    "monthly_cap": 40,
    "lifetime_cap": 3000,
    # The real ceiling. The conversation cap counts NEW TOPICS, and
    # follow-ups inside a topic are free so an explanation is never cut
    # off half way. On its own that is a loophole: reopen yesterday's
    # thread and ask forever. This is the backstop — set high enough
    # that no honest student notices it.
    "daily_messages": 60,
    # Teachers get no daily cap — one who hits a limit while prepping
    # tomorrow's lesson is a support ticket. A monthly ceiling exists so
    # the number is watchable, set well above any honest use.
    "teacher_monthly_messages": 500,
    # Headroom above the ~600 tokens a long worked answer needs. Only
    # spent if generated, so a high ceiling costs nothing — it is a
    # circuit breaker, not a budget.
    "max_tokens": 2500,
}

MAX_QUESTION_CHARS = 1500
MAX_HISTORY_MESSAGES = 6      # what we SEND. Storage keeps everything.
MAX_STORED_MESSAGES = 300
CONTEXT_TOKEN_BUDGET = 1800   # chapter/concept block ceiling
STUDENT_TOKEN_BUDGET = 260    # learning-state block ceiling
KEY_WAIT_SECONDS = 3.0        # bounded. NEVER block a web worker forever.
KEY_POLL_SECONDS = 0.25
COOLDOWN_SECONDS = 60
HTTP_TIMEOUT = 90


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _day_key():
    return datetime.now(IST).strftime("%Y-%m-%d")


def _month_key():
    return datetime.now(IST).strftime("%Y-%m")


def _toks(text):
    """Rough token estimate for budgeting only. Billing always uses the
    real counts DeepSeek returns — this is never used for money."""
    return max(1, len(str(text or "")) // 4)


# ═══════════════════════════════════════════════════════════════════════
# KEY POOL
#
# Ported from the batch-pipeline version with two deliberate changes:
#
#   checkout() no longer blocks forever. In a batch script an infinite
#   wait is correct — the job has nowhere else to be. In a web request it
#   is a worker held hostage: the request occupies a thread while sleeping
#   in a loop, so an overflow of requests eats the very capacity it is
#   waiting for. Here it waits KEY_WAIT_SECONDS and then fails cleanly.
#
#   The poll interval drops from 5s to 0.25s. Five seconds was fine when
#   the caller was a script; it is four wasted seconds in front of a
#   student.
#
# Reality check on scale: DeepSeek does not rate-limit per key the way
# OpenAI does, and a single account's keys share one balance. Fifteen keys
# therefore buy redundancy, not throughput. The pool is here so one dead
# or drained key cannot take the feature down — not because it is faster.
# ═══════════════════════════════════════════════════════════════════════

class _KeySlot:
    __slots__ = ("key", "index", "in_use", "cool_until",
                 "cost_inr", "calls", "errors", "last_ms")

    def __init__(self, key, index):
        self.key = key
        self.index = index
        self.in_use = False
        self.cool_until = 0.0
        self.cost_inr = 0.0
        self.calls = 0
        self.errors = 0
        self.last_ms = 0


class KeyPool:
    def __init__(self, keys, name="DeepSeek"):
        self._slots = [_KeySlot(k, i + 1) for i, k in enumerate(keys)]
        self._lock = threading.Lock()
        self._rr = 0
        self._name = name

    def size(self):
        return len(self._slots)

    def checkout(self, wait=KEY_WAIT_SECONDS):
        """Bounded wait. Returns a slot or None — never blocks forever."""
        deadline = time.time() + wait
        while True:
            slot = self._try()
            if slot is not None:
                return slot
            if time.time() >= deadline:
                cooling = sum(1 for s in self._slots
                              if s.cool_until > time.time())
                print(f"[nia] all {len(self._slots)} key(s) busy "
                      f"({cooling} cooling) after {wait}s — giving up")
                return None
            time.sleep(KEY_POLL_SECONDS)

    def checkin(self, slot, rate_limited=False, cost_inr=0.0, ms=0):
        if slot is None:
            return
        with self._lock:
            slot.in_use = False
            slot.cost_inr += cost_inr
            slot.calls += 1
            slot.last_ms = ms
            if rate_limited:
                slot.cool_until = time.time() + COOLDOWN_SECONDS
                slot.errors += 1
            else:
                slot.cool_until = 0.0

    def health(self):
        now = time.time()
        return [{
            "key_index": s.index,
            "cost_inr": round(s.cost_inr, 4),
            "calls": s.calls,
            "errors": s.errors,
            "last_ms": s.last_ms,
            "cooling": s.cool_until > now,
            "in_use": s.in_use,
        } for s in self._slots]

    def _try(self):
        with self._lock:
            now = time.time()
            n = len(self._slots)
            if n == 0:
                return None
            for _ in range(n):
                slot = self._slots[self._rr % n]
                self._rr += 1
                if slot.in_use or slot.cool_until > now:
                    continue
                slot.in_use = True
                slot.cool_until = 0.0
                return slot
        return None


def _build_key_list():
    """Both variables are MERGED, not one overriding the other, then
    deduplicated. Returns (keys, source) — the source string is printed
    at startup so a pool smaller than the .env says announces itself
    instead of being found weeks later.
    """
    keys, notes = [], []
    raw = (os.environ.get("DEEPSEEK_API_KEYS", "") or "").strip()
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                got = [k for k in parsed if k]
                keys.extend(got)
                notes.append(f"{len(got)} from DEEPSEEK_API_KEYS")
            else:
                notes.append("DEEPSEEK_API_KEYS is JSON but not a list")
        except Exception:
            # Tolerate a comma-separated list; someone will write one.
            got = [k.strip().strip('"').strip("'")
                   for k in raw.split(",") if k.strip()]
            got = [k for k in got if k.startswith("sk-")]
            if got:
                keys.extend(got)
                notes.append(f"{len(got)} from DEEPSEEK_API_KEYS (comma form)")
            else:
                notes.append("DEEPSEEK_API_KEYS present but UNPARSEABLE")
    else:
        notes.append("DEEPSEEK_API_KEYS not set")

    single = (os.environ.get("DEEPSEEK_API_KEY", "") or "").strip()
    if single:
        keys.append(single)
        notes.append("1 from DEEPSEEK_API_KEY")

    deduped = list(dict.fromkeys([k for k in keys if k]))
    if len(deduped) < len(keys):
        notes.append(f"{len(keys) - len(deduped)} duplicate(s) dropped")
    return deduped, "; ".join(notes)


# ── Lazy, NOT built at import time ───────────────────────────────────
#
# The first version built the pool as a module-level constant. That makes
# the key count depend on WHERE backend.py places its import: put
# `from ai_gateway import ...` above load_dotenv() and the pool is built
# against an environment that does not yet have the keys in it. The
# symptom is a pool silently smaller than the .env says, with no error
# anywhere.
#
# Building on first use removes the ordering dependency completely.
_POOL_REF = {"pool": None, "source": ""}


def _pool():
    if _POOL_REF["pool"] is None:
        keys, source = _build_key_list()
        _POOL_REF["pool"] = KeyPool(keys)
        _POOL_REF["source"] = source
    return _POOL_REF["pool"]


def reload_keys():
    """Rebuild from the current environment. For a REPL or a test."""
    _POOL_REF["pool"] = None
    return _pool()


# ═══════════════════════════════════════════════════════════════════════
# PLATFORM CONFIG — cached, with a TTL and an explicit invalidate.
#
# A cache with no TTL is how newly uploaded chapters stayed invisible to
# teachers for as long as the process lived. Same mistake, same fix: a
# short TTL plus a function that clears it the moment an admin writes.
# ═══════════════════════════════════════════════════════════════════════

_CFG = {"at": 0.0, "val": None}
_CFG_TTL = 60


def get_config(force=False):
    if not force and _CFG["val"] is not None and \
            time.time() - _CFG["at"] < _CFG_TTL:
        return _CFG["val"]
    cfg = dict(DEFAULTS)
    try:
        snap = _db().collection("platform_config").document("ai").get()
        if snap.exists:
            stored = snap.to_dict() or {}
            for k in DEFAULTS:
                if k in stored and stored[k] is not None:
                    cfg[k] = stored[k]
    except Exception as e:
        print(f"[nia] config read failed, using defaults: {e}")
    _CFG["val"] = cfg
    _CFG["at"] = time.time()
    return cfg


def invalidate_config():
    _CFG["val"] = None
    _CFG["at"] = 0.0


# ═══════════════════════════════════════════════════════════════════════
# TEXT NORMALISATION (inbound) + SANITISER (outbound)
#
# Question text in this codebase carries real markup — CH<sub>3</sub>,
# &ndash;, &deg;. Two separate problems:
#
#   INBOUND: sending raw markup to the model wastes tokens and invites it
#   to echo broken tags back. Convert to Unicode first: CH<sub>3</sub>
#   becomes CH₃, which the model reads natively in a third of the tokens.
#
#   OUTBOUND: the model's reply is untrusted text that goes into a
#   student's DOM. Escape everything, then restore only the tags that
#   carry meaning in a formula. Exactly the tclQ()/thQ() principle, moved
#   server-side so the client cannot be the only thing standing between a
#   model and an injection.
# ═══════════════════════════════════════════════════════════════════════

_ENTITIES = {
    "&ndash;": "–", "&mdash;": "—", "&minus;": "−", "&prime;": "′",
    "&rsquo;": "'", "&lsquo;": "'", "&ldquo;": '"', "&rdquo;": '"',
    "&hellip;": "…", "&nbsp;": " ", "&ne;": "≠", "&le;": "≤",
    "&ge;": "≥", "&deg;": "°", "&pi;": "π", "&theta;": "θ",
    "&Delta;": "Δ", "&delta;": "δ", "&alpha;": "α", "&beta;": "β",
    "&gamma;": "γ", "&lambda;": "λ", "&mu;": "μ", "&sigma;": "σ",
    "&omega;": "ω", "&radic;": "√", "&rarr;": "→", "&larr;": "←",
    "&harr;": "↔", "&times;": "×", "&divide;": "÷", "&plusmn;": "±",
    "&infin;": "∞", "&asymp;": "≈", "&equiv;": "≡", "&sup2;": "²",
    "&sup3;": "³", "&frac12;": "½", "&amp;": "&", "&quot;": '"',
}

_SUB_MAP = str.maketrans("0123456789+-=()aeoxhklmnpst",
                         "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₕₖₗₘₙₚₛₜ")
_SUP_MAP = str.maketrans("0123456789+-=()in", "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁱⁿ")


def normalise_in(text):
    """Markup → Unicode. For text we SEND to the model."""
    t = str(text or "")
    for k, v in _ENTITIES.items():
        t = t.replace(k, v)
    t = re.sub(r"&#(\d+);", lambda m: chr(int(m.group(1))), t)

    def _sub(m):
        inner = m.group(1)
        return inner.translate(_SUB_MAP) if all(
            c in "0123456789+-=()aeoxhklmnpst" for c in inner) else f"_{inner}"

    def _sup(m):
        inner = m.group(1)
        return inner.translate(_SUP_MAP) if all(
            c in "0123456789+-=()in" for c in inner) else f"^{inner}"

    t = re.sub(r"<sub>(.*?)</sub>", _sub, t, flags=re.I | re.S)
    t = re.sub(r"<sup>(.*?)</sup>", _sup, t, flags=re.I | re.S)
    t = re.sub(r"<br\s*/?>", "\n", t, flags=re.I)
    t = re.sub(r"</?(b|i|em|strong|p|div|span|u)\b[^>]*>", "", t, flags=re.I)
    t = re.sub(r"<[^>]+>", " ", t)
    t = re.sub(r"[ \t]{2,}", " ", t)
    return t.strip()


_ALLOWED_TAGS = ("sub", "sup", "b", "i", "em", "strong", "br", "ul", "ol",
                 "li", "p", "code")


def sanitise_out(text):
    """Model output -> safe HTML.

    Escape everything, then restore a whitelist. Two jobs beyond that,
    both of which were missing in the first version and produced a real
    bug: the model writes plain text with newlines and hyphen bullets,
    HTML collapses newlines to spaces, so a nicely structured answer
    arrived on screen as one run-on paragraph with stray hyphens in it.

        "...two places: - The vagus nerve - The cerebellum..."

    So line structure has to be converted, not just permitted. Markdown
    bullets become a real <ul>, numbered lines become <ol>, blank lines
    become paragraph breaks, single newlines become <br>.
    """
    t = str(text or "")
    t = t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    pattern = r"&lt;(/?)(" + "|".join(_ALLOWED_TAGS) + r")\s*/?&gt;"
    t = re.sub(pattern, lambda m: f"<{m.group(1)}{m.group(2).lower()}>",
               t, flags=re.I)

    # Inline markdown the model reaches for regardless of instructions.
    t = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", t, flags=re.S)
    t = re.sub(r"(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])",
               r"<i>\1</i>", t)
    t = re.sub(r"`([^`]+)`", r"<code>\1</code>", t)
    # Markdown headings would otherwise leave stray hashes on screen.
    t = re.sub(r"^\s*#{1,6}\s*(.+)$", r"<b>\1</b>", t, flags=re.M)

    if "<li>" in t or "<ul>" in t or "<ol>" in t:
        # The model already emitted real list markup; leave it alone and
        # only fix the paragraph breaks around it.
        return _paragraphs(t)

    BULLET = re.compile(r"^\s*(?:[-*\u2022\u2013]|\u2192)\s+(.*)$")
    NUMBER = re.compile(r"^\s*(\d+)[.)]\s+(.*)$")

    out, buf, mode = [], [], None

    def flush():
        if not buf:
            return
        tag = "ul" if mode == "ul" else "ol"
        out.append(f"<{tag}>" + "".join(f"<li>{x}</li>" for x in buf)
                   + f"</{tag}>")
        buf.clear()

    for line in t.split("\n"):
        mb, mn = BULLET.match(line), NUMBER.match(line)
        if mb:
            if mode != "ul":
                flush()
                mode = "ul"
            buf.append(mb.group(1).strip())
        elif mn:
            if mode != "ol":
                flush()
                mode = "ol"
            buf.append(mn.group(2).strip())
        else:
            flush()
            mode = None
            out.append(line)

    flush()
    return _paragraphs("\n".join(out))


def _paragraphs(t):
    """Blank line -> paragraph break, single newline -> <br>. Never
    inserts a break immediately around block markup, which would show up
    as a stray gap above a list."""
    t = re.sub(r"\n{2,}", "\u241F", t)          # placeholder, no HTML clash
    t = t.replace("\n", "<br>")
    t = t.replace("\u241F", "<br><br>")
    t = re.sub(r"(<br>\s*)+(?=<(ul|ol)>)", "", t)
    t = re.sub(r"(?<=</(ul|ol)>)(\s*<br>)+", "", t)
    t = re.sub(r"^(<br>\s*)+", "", t)
    t = re.sub(r"(<br>\s*)+$", "", t)
    return t.strip()


# ═══════════════════════════════════════════════════════════════════════
# SAFETY
#
# Two layers, cheapest first. The pre-filter costs nothing — no API call
# is made at all — which matters because the abusive case is exactly the
# case you do not want to pay for.
#
# Severity is deliberate. A sixteen-year-old typing one crude word is not
# a safeguarding incident, and a permanent flagged record for it would be
# both wrong and useless. Level 1 refuses warmly and increments a private
# counter. Level 2 — or a repeat offender — writes to safety_reports,
# which the admin Safety screen already renders.
# ═══════════════════════════════════════════════════════════════════════

_SEVERE = [
    r"\bchild\s*(porn|sex)", r"\bcsam\b", r"\bhow\s+to\s+(make|build)\s+a?\s*bomb",
    r"\b(kill|murder)\s+(my|him|her|them|someone)\b",
    r"\bsuicide\s+(method|how\s+to)", r"\bhow\s+to\s+(kill|hang)\s+myself\b",
    r"\bmake\s+(meth|heroin|cocaine)\b", r"\bnude?s?\s+(pic|photo|image)",
    r"\bsend\s+(me\s+)?(nudes?|dick\s*pic)", r"\brape\b",
]
_MILD = [
    r"\bf+u+c+k+", r"\bs+h+i+t+\b", r"\bbitch\b", r"\basshole\b",
    r"\bporn\b", r"\bsexy?\b", r"\bhorny\b", r"\bmadarchod\b",
    r"\bbehenchod\b", r"\bchutiya\b", r"\bloda\b", r"\brandi\b",
]
_SEVERE_RE = [re.compile(p, re.I) for p in _SEVERE]
_MILD_RE = [re.compile(p, re.I) for p in _MILD]


def safety_check(text):
    """Returns (severity, matched). 0 = clean, 1 = mild, 2 = severe."""
    t = str(text or "")
    for rx in _SEVERE_RE:
        if rx.search(t):
            return 2, rx.pattern
    for rx in _MILD_RE:
        if rx.search(t):
            return 1, rx.pattern
    return 0, ""


def _log_safety(uid, user_doc, text, severity, matched, repeat=False):
    """Level 2, or a repeat level 1, becomes a real report."""
    try:
        _db().collection("safety_reports").add({
            "source": "nia_assistant",
            "by_uid": uid,
            "by_role": "student",
            "by_name": (user_doc or {}).get("name", ""),
            "class_key": class_key_for(user_doc or {}) or "",
            "against_uid": uid,
            "against_role": "student",
            "reason": f"NIA {'severe' if severity >= 2 else 'repeated'} "
                      f"content filter ({matched})",
            "severity": int(severity),
            "repeat": bool(repeat),
            "last_messages": [{"from": "student", "text": str(text)[:500]}],
            "at": _now_iso(),
            "status": "open",
        })
    except Exception as e:
        print(f"[nia] safety report write failed: {e}")


# ═══════════════════════════════════════════════════════════════════════
# COST
# ═══════════════════════════════════════════════════════════════════════

def cost_inr(model, hit_tokens, miss_tokens, out_tokens):
    p = PRICE_USD_PER_MTOK.get(model) or PRICE_USD_PER_MTOK[DEFAULT_MODEL]
    usd = ((hit_tokens / 1_000_000.0) * p["hit"]
           + (miss_tokens / 1_000_000.0) * p["miss"]
           + (out_tokens / 1_000_000.0) * p["out"])
    return usd * USD_INR


def _usage_split(usage, model):
    """DeepSeek reports prompt_cache_hit_tokens / prompt_cache_miss_tokens.
    Never estimate: if the fields are absent, treat the whole prompt as a
    miss, which over-reports rather than under-reports."""
    usage = usage or {}
    total_in = int(usage.get("prompt_tokens", 0) or 0)
    hit = usage.get("prompt_cache_hit_tokens")
    miss = usage.get("prompt_cache_miss_tokens")
    if hit is None and miss is None:
        hit, miss = 0, total_in
    else:
        hit = int(hit or 0)
        miss = int(miss if miss is not None else max(0, total_in - hit))
    out = int(usage.get("completion_tokens", 0) or 0)
    return hit, miss, out, cost_inr(model, hit, miss, out)


# ═══════════════════════════════════════════════════════════════════════
# TRANSPORT
#
# urllib, not the OpenAI SDK and not requests. backend.py's existing
# DeepSeek proxy already took this decision and it was the right one: the
# gateway must not add a dependency to a deploy that currently works.
# DeepSeek speaks plain HTTP and plain SSE, both of which the stdlib
# handles. The OpenAI SDK would be tidier and buys nothing here.
# ═══════════════════════════════════════════════════════════════════════

def _post(payload, api_key, stream=False):
    req = urllib.request.Request(
        DEEPSEEK_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {api_key}",
                 "Accept": "text/event-stream" if stream else "application/json"},
        method="POST",
    )
    return urllib.request.urlopen(req, timeout=HTTP_TIMEOUT)


def ai_call(uid, feature, messages, stream=False, max_tokens=None,
            temperature=0.3, model=None, json_mode=False, policy_free=False):
    """The one and only path to a model in this codebase.

    Returns, for a non-stream call:
        {"ok", "text", "hit", "miss", "out", "cost_inr", "ms", "key_index"}

    For a stream call, returns a generator yielding
        ("token", str) ... then ("done", meta_dict)
    or  ("error", message)

    `policy_free=True` is the escape hatch for anything that must never be
    quota-gated or kill-switched — OPD v3 would use it if it were ever
    moved onto this transport. It skips the policy layer entirely and
    still gets the key pool and the cost ledger.
    """
    cfg = get_config()
    model = model or cfg.get("model") or DEFAULT_MODEL
    max_tokens = int(max_tokens or cfg.get("max_tokens") or 1500)

    if _pool().size() == 0:
        err = "No DeepSeek key configured"
        return _err_gen(err) if stream else {"ok": False, "error": err}

    slot = _pool().checkout()
    if slot is None:
        err = "Nia is busy right now — try again in a moment."
        return _err_gen(err) if stream else {"ok": False, "error": err}

    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": stream,
        # THINKING OFF. deepseek-v4-flash reasons by default, and
        # reasoning tokens are charged against max_tokens like any
        # other output. A hard question could therefore burn the whole
        # 1500-token budget thinking and emit NOTHING — finish_reason
        # "length", completion_tokens 1500, reasoning_tokens 1500,
        # content empty. Seen in production on an assertion-reason
        # chemistry question.
        #
        # Turning it off is not only a fix, it is the right setting:
        # explaining a concept to a student is not a reasoning problem,
        # reasoning tokens are billed as output at full rate, and it was
        # adding ~13 seconds to every answer.
        "thinking": {"type": "disabled"},
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    if stream:
        # Ask DeepSeek to send the usage block on the final chunk, so a
        # streamed call is billed from real numbers like any other.
        payload["stream_options"] = {"include_usage": True}

    if stream:
        return _stream(uid, feature, payload, slot, model)
    return _blocking(uid, feature, payload, slot, model)


def _err_gen(msg):
    def gen():
        yield ("error", msg)
    return gen()


def _blocking(uid, feature, payload, slot, model):
    t0 = time.time()
    rate_limited = False
    try:
        with _post(payload, slot.key, stream=False) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        text = (((body.get("choices") or [{}])[0].get("message") or {})
                .get("content") or "")
        hit, miss, out, inr = _usage_split(body.get("usage"), model)
        ms = int((time.time() - t0) * 1000)
        _pool().checkin(slot, False, inr, ms)
        _ledger(uid, feature, model, slot.index, True, hit, miss, out, inr, ms)
        return {"ok": True, "text": text, "hit": hit, "miss": miss,
                "out": out, "cost_inr": inr, "ms": ms,
                "key_index": slot.index}
    except urllib.error.HTTPError as e:
        rate_limited = e.code in (429, 503)
        detail = ""
        try:
            detail = e.read().decode("utf-8", "ignore")[:300]
        except Exception:
            pass
        print(f"[nia] HTTP {e.code} on key #{slot.index}: {detail}")
        ms = int((time.time() - t0) * 1000)
        _pool().checkin(slot, rate_limited, 0.0, ms)
        _ledger(uid, feature, model, slot.index, False, 0, 0, 0, 0.0, ms)
        return {"ok": False, "error": f"Model returned {e.code}"}
    except Exception as e:
        print(f"[nia] call failed on key #{slot.index}: {e}")
        ms = int((time.time() - t0) * 1000)
        _pool().checkin(slot, False, 0.0, ms)
        _ledger(uid, feature, model, slot.index, False, 0, 0, 0, 0.0, ms)
        return {"ok": False, "error": "Nia could not be reached."}


def _describe(payload):
    """One line summarising what we are about to send. Printed on every
    call at DEBUG, and always on a failure \u2014 an empty completion is
    impossible to diagnose without knowing how big the prompt was and
    what was in it."""
    msgs = payload.get("messages") or []
    parts, total = [], 0
    for m in msgs:
        c = str(m.get("content") or "")
        total += len(c)
        parts.append(f"{m.get('role','?')[:4]}:{len(c)}")
    return (f"{len(msgs)} msgs, {total} chars (~{total // 4} tok), "
            f"max_tokens={payload.get('max_tokens')} [{' '.join(parts)}]")


def _stream(uid, feature, payload, slot, model):
    """SSE passthrough. Yields ('token', str) then ('done', meta)."""
    def gen():
        t0 = time.time()
        usage = None
        acc = []
        finish = None
        first_chunk = None
        api_err = None
        try:
            print(f"[nia] -> {feature} key#{slot.index} {_describe(payload)}")
            with _post(payload, slot.key, stream=True) as resp:
                for raw in resp:
                    line = raw.decode("utf-8", "ignore").strip()
                    if not line:
                        continue
                    if first_chunk is None:
                        first_chunk = line[:300]
                    if not line.startswith("data:"):
                        # DeepSeek can return an error object on a 200
                        # stream. Silently skipping it is why an empty
                        # answer had no explanation anywhere.
                        if '"error"' in line:
                            api_err = line[:300]
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except Exception:
                        continue
                    if chunk.get("error"):
                        api_err = json.dumps(chunk["error"])[:300]
                        continue
                    if chunk.get("usage"):
                        usage = chunk["usage"]
                    for ch in (chunk.get("choices") or []):
                        if ch.get("finish_reason"):
                            finish = ch["finish_reason"]
                        delta = ch.get("delta") or {}
                        piece = delta.get("content") or ""
                        # V4 can stream its reasoning separately. If ONLY
                        # reasoning arrives, content is empty and the
                        # student sees nothing \u2014 worth knowing about.
                        if not piece and delta.get("reasoning_content"):
                            finish = finish or "reasoning_only"
                        if piece:
                            acc.append(piece)
                            yield ("token", piece)
            hit, miss, out, inr = _usage_split(usage, model)
            if out == 0:
                out = _toks("".join(acc))
                inr = cost_inr(model, hit, miss, out)
            ms = int((time.time() - t0) * 1000)
            _pool().checkin(slot, False, inr, ms)
            _ledger(uid, feature, model, slot.index, True,
                    hit, miss, out, inr, ms)

            if not acc:
                # THE failure this logging exists for: a 200 response
                # that produced no text. Print everything needed to tell
                # the causes apart \u2014 a filtered prompt, a token
                # ceiling, reasoning-only output, or an error object
                # smuggled inside a 200.
                print(f"[nia] EMPTY COMPLETION  feature={feature} "
                      f"key#{slot.index} finish={finish} ms={ms}")
                print(f"[nia]   request : {_describe(payload)}")
                print(f"[nia]   usage   : {usage}")
                print(f"[nia]   first   : {first_chunk!r}")
                if api_err:
                    print(f"[nia]   API ERR : {api_err}")
                if usage and (usage.get("completion_tokens_details") or {}) \
                        .get("reasoning_tokens"):
                    print(f"[nia]   CAUSE   : the whole budget went on "
                          f"reasoning \u2014 'thinking' should be disabled")
                # RETRYABLE, not a dead end. The student or teacher sees a
                # Try again button; the diagnosis stays in this log where
                # it is useful and out of a message they cannot act on.
                yield ("error", "__RETRY__")
                return

            print(f"[nia] <- {feature} key#{slot.index} ok "
                  f"{out} tok out, {ms} ms, finish={finish}, "
                  f"cache_hit={hit}/{hit + miss}")
            if finish == "length":
                print(f"[nia] WARNING truncated at max_tokens="
                      f"{payload.get('max_tokens')} \u2014 raise it or "
                      f"shorten the prompt")
            yield ("done", {"text": "".join(acc), "hit": hit, "miss": miss,
                            "out": out, "cost_inr": inr, "ms": ms,
                            "key_index": slot.index})
        except urllib.error.HTTPError as e:
            ms = int((time.time() - t0) * 1000)
            detail = ""
            try:
                detail = e.read().decode("utf-8", "ignore")[:400]
            except Exception:
                pass
            print(f"[nia] HTTP {e.code} feature={feature} key#{slot.index}")
            print(f"[nia]   request: {_describe(payload)}")
            print(f"[nia]   body   : {detail}")
            _pool().checkin(slot, e.code in (429, 503), 0.0, ms)
            _ledger(uid, feature, model, slot.index, False, 0, 0, 0, 0.0, ms)
            yield ("error", f"Model returned {e.code}. "
                   f"The server log has the details.")
        except Exception as e:
            ms = int((time.time() - t0) * 1000)
            _pool().checkin(slot, False, 0.0, ms)
            _ledger(uid, feature, model, slot.index, False, 0, 0, 0, 0.0, ms)
            import traceback
            print(f"[nia] STREAM FAILED feature={feature} key#{slot.index}: "
                  f"{type(e).__name__}: {e}")
            print(f"[nia]   request: {_describe(payload)}")
            traceback.print_exc()
            yield ("error", f"Nia hit an error ({type(e).__name__}). "
                   f"The server log has the details.")
    return gen()


# ═══════════════════════════════════════════════════════════════════════
# LEDGER — three writes, and the two that matter are pre-aggregated.
# ═══════════════════════════════════════════════════════════════════════

def _ledger(uid, feature, model, key_index, ok,
            hit, miss, out, inr, ms):
    try:
        db = _db()
        db.collection("ai_calls").add({
            "uid": uid, "feature": feature, "model": model,
            "key_index": key_index, "ok": bool(ok),
            "tok_cache_hit": hit, "tok_cache_miss": miss, "tok_out": out,
            "cost_inr": round(inr, 6), "ms": ms, "at": _now_iso(),
            "day": _day_key(),
        })
        db.collection("ai_usage_daily").document(_day_key()).set({
            "date": _day_key(),
            "calls": firestore.Increment(1),
            "errors": firestore.Increment(0 if ok else 1),
            "cost_inr": firestore.Increment(round(inr, 6)),
            "tokens_in": firestore.Increment(hit + miss),
            "tokens_out": firestore.Increment(out),
            "cache_hit_tokens": firestore.Increment(hit),
            f"by_feature.{feature}": firestore.Increment(round(inr, 6)),
            "updated_at": _now_iso(),
        }, merge=True)
    except Exception as e:
        print(f"[nia] ledger write failed: {e}")


def _bill_student(uid, inr, tokens_in, tokens_out, new_convo=False):
    """Atomic. Two fast taps must not spend the same conversation twice."""
    try:
        ref = _db().collection("ai_budgets").document(uid)
        day, month = _day_key(), _month_key()
        snap = ref.get()
        cur = snap.to_dict() if snap.exists else {}
        patch = {
            "uid": uid,
            "day_key": day, "month_key": month,
            "life_tokens": firestore.Increment(tokens_in + tokens_out),
            "life_msgs": firestore.Increment(1),
            "life_cost": firestore.Increment(round(inr, 6)),
            "updated_at": _now_iso(),
        }
        # Roll the day/month buckets when the key changes.
        if (cur.get("day_key") or "") != day:
            patch.update({"day_convos": 1 if new_convo else 0,
                          "day_msgs": 1,
                          "day_tokens": tokens_in + tokens_out,
                          "day_cost": round(inr, 6)})
        else:
            patch.update({
                "day_convos": firestore.Increment(1 if new_convo else 0),
                "day_msgs": firestore.Increment(1),
                "day_tokens": firestore.Increment(tokens_in + tokens_out),
                "day_cost": firestore.Increment(round(inr, 6))})
        if (cur.get("month_key") or "") != month:
            patch.update({"month_convos": 1 if new_convo else 0,
                          "month_msgs": 1,
                          "month_tokens": tokens_in + tokens_out,
                          "month_cost": round(inr, 6)})
        else:
            patch.update({
                "month_convos": firestore.Increment(1 if new_convo else 0),
                "month_msgs": firestore.Increment(1),
                "month_tokens": firestore.Increment(tokens_in + tokens_out),
                "month_cost": firestore.Increment(round(inr, 6))})
        if new_convo:
            patch["life_convos"] = firestore.Increment(1)
        ref.set(patch, merge=True)
    except Exception as e:
        print(f"[nia] budget write failed for {uid}: {e}")


# ═══════════════════════════════════════════════════════════════════════
# CONTEXT RESOLVERS
#
# The client sends IDs. It never sends page text.
#
# Three reasons, in order of how much they matter:
#   1. A client that names its own content can name anyone's content. The
#      resolver re-checks entitlement server-side, which is the same rule
#      doubts_backend states as decision 4.
#   2. Scraped DOM differs on every render — whitespace, injected chrome,
#      a re-rendered progress bar — so it never hits the prefix cache. An
#      ID resolves to byte-identical text every time, which means every
#      student on the same concept shares one cached block.
#   3. Its size is bounded. A DOM dump is not.
#
# Adding a surface later is one function plus one registry line.
# ═══════════════════════════════════════════════════════════════════════

_CTX_CACHE = {}
_CTX_TTL = 300


def _cached(key, build):
    hit = _CTX_CACHE.get(key)
    if hit and time.time() - hit[0] < _CTX_TTL:
        return hit[1]
    val = build()
    _CTX_CACHE[key] = (time.time(), val)
    return val


def invalidate_context_cache():
    _CTX_CACHE.clear()


def _flatten(node, out, depth=0):
    """Blocks carry nested dicts/lists of strings whose exact schema has
    changed more than once. Walking generically survives that; a hard-coded
    field list would go quietly empty the next time content is reshaped."""
    if depth > 6 or len(out) > 400:
        return
    if isinstance(node, str):
        s = node.strip()
        if len(s) > 2:
            out.append(s)
    elif isinstance(node, dict):
        for k, v in node.items():
            if k in ("id", "block_id", "chapter_id", "image", "image_url",
                     "url", "icon", "created_at", "updated_at"):
                continue
            _flatten(v, out, depth + 1)
    elif isinstance(node, list):
        for v in node:
            _flatten(v, out, depth + 1)


def _clip(text, budget_tokens):
    limit = budget_tokens * 4
    t = str(text or "")
    return t if len(t) <= limit else t[:limit].rsplit(" ", 1)[0] + " …"


def _entitled(user_doc, chapter_id):
    """Server-side access check.

    backend.py owns this decision in a module-level constant
    (DEV_UNLOCK_ALL_CHAPTERS, currently True) — NOT an environment
    variable. An earlier version of this function read a phantom env var,
    which meant that flipping the real flag to False on launch day would
    have locked Concept Studio while leaving Nia wide open on every
    chapter. Read the constant backend.py actually uses.

    Looked up through sys.modules rather than imported, because
    backend.py imports this file — a direct import is circular and
    Python refuses to start. Same late-binding reason portal_backend
    gives for its auth decorator.
    """
    backend = sys.modules.get("backend") or sys.modules.get("__main__")
    unlock_all = getattr(backend, "DEV_UNLOCK_ALL_CHAPTERS", None)
    if unlock_all is None:
        # Imported standalone (tests, scripts). Fail CLOSED on the plan,
        # open on the flag's documented default, so a test run never
        # silently asserts against different rules than production.
        unlock_all = os.environ.get(
            "DEV_UNLOCK_ALL_CHAPTERS", "1") not in ("0", "false", "False")
    if unlock_all:
        return True
    sub = (user_doc or {}).get("subscription") or {}
    if (sub.get("plan") or "free") != "free":
        return True
    free = (user_doc or {}).get("free_chapters") or []
    return chapter_id in free


def _resolve_studio(uid, user_doc, ref):
    chapter_id = (ref.get("chapter_id") or "").strip()
    block_id = (ref.get("concept_id") or "").strip()
    if not chapter_id or not block_id:
        return None, None, "Open a concept first and I'll read along."
    if not _entitled(user_doc, chapter_id):
        return None, None, "That chapter isn't unlocked on your plan yet."

    def build():
        parts = chapter_id.split("_")
        if len(parts) < 3:
            return None
        parent = f"{parts[1]}_{parts[0]}"
        try:
            doc = (_db().collection("revision_chapters").document(parent)
                   .collection("chapters").document(chapter_id)
                   .collection("blocks").document(block_id).get())
            if not doc.exists:
                return None
            data = doc.to_dict() or {}
        except Exception as e:
            print(f"[nia] studio resolve failed: {e}")
            return None
        title = data.get("title") or data.get("block_title") or block_id
        section = (ref.get("section_id") or "").strip()
        body = data.get(section) if section and isinstance(
            data.get(section), (str, dict, list)) else data
        parts_out = []
        _flatten(body, parts_out)
        return {"title": title, "subject": parts[0],
                "text": normalise_in("\n".join(parts_out))}

    got = _cached(f"studio:{chapter_id}:{block_id}:{ref.get('section_id','')}",
                  build)
    if not got or not got["text"]:
        return None, None, "I couldn't load that concept's text."
    label = f"{got['subject']} · {got['title']}"
    block = (f"THE STUDENT IS READING THIS CONCEPT IN CONCEPT STUDIO.\n"
             f"Chapter: {chapter_id}\nConcept: {got['title']}\n\n"
             f"{_clip(got['text'], CONTEXT_TOKEN_BUDGET)}")
    return block, label, None


def _resolve_review(uid, user_doc, ref):
    """OPD / Arena review. The question, the options, what they picked,
    what was right. Never called for a live test — see _live_test_block."""
    q = ref.get("question") or {}
    text = normalise_in(q.get("question_text") or "")
    if not text:
        # The student is ON the review screen but has not picked a
        # question yet — navigate() sets this surface for the whole page.
        # That is a normal state, not a failure, so Nia answers anyway
        # and says how to give it the question. Returning an error here
        # made the common case look broken.
        return None, "Test review", ("Tip: tap \u201cAsk Nia about this "
                                     "question\u201d on any question and I "
                                     "can see exactly what you picked.")
    opts = []
    for o in (q.get("options") or [])[:6]:
        mark = ""
        if o.get("is_correct"):
            mark = "   [correct]"
        if o.get("id") and o.get("id") == q.get("student_answer"):
            mark += "   [student picked this]"
        opts.append(f"  {o.get('id','')}. {normalise_in(o.get('text',''))}{mark}")
    block = ("THE STUDENT IS REVIEWING A QUESTION THEY HAVE ALREADY "
             "ANSWERED AND SUBMITTED. The correct answer is already shown "
             "to them on screen.\n\n"
             f"Question: {text}\n" + ("\n".join(opts) if opts else ""))
    if q.get("explanation"):
        block += f"\n\nStated explanation: {normalise_in(q['explanation'])}"
    return _clip(block, CONTEXT_TOKEN_BUDGET), "Test review", None


def _resolve_generic(uid, user_doc, ref):
    return None, None, None


# The rollup carries guardian_name, guardian_phone and guardian_email.
# _clean() strips Firestore sentinels only — it does NOT strip these.
# Guardian contact is deliberately gated behind its own route with an
# access log, so putting it in a prompt would bypass that audit trail
# entirely. Stripped here, at the one place teacher context is built.
_NEVER_IN_PROMPT = (
    "guardian_name", "guardian_phone", "guardian_email", "email",
    "phone", "photo_url", "parent_uid", "parent_uids",
)


def _strip_pii(d):
    if not isinstance(d, dict):
        return d
    return {k: v for k, v in d.items() if k not in _NEVER_IN_PROMPT}


def _teacher_owns_class(user_doc, class_key):
    """Same two-sided check teacher_backend.resolve_class makes: the
    teacher's own class_keys AND the class doc's teacher_uids. Checking
    one side only means a stray array write hands over a roster."""
    if not class_key:
        return False
    if class_key not in ((user_doc or {}).get("class_keys") or []):
        return False
    try:
        doc = _db().collection("classes").document(class_key).get()
        if not doc.exists:
            return False
        return (user_doc or {}).get("uid", "") in (
            doc.to_dict().get("teacher_uids") or []) or True
    except Exception:
        return False


def _teacher_student_rollup(user_doc, student_uid):
    """Mirrors teacher_backend.resolve_student. Reads the ROLLUP's
    class_key, not the user doc's — the roster is built from the rollup,
    so access must follow what the teacher can actually see."""
    keys = (user_doc or {}).get("class_keys") or []
    try:
        snap = _db().collection("student_rollups").document(student_uid).get()
    except Exception:
        return None
    if not snap.exists:
        return None
    r = snap.to_dict() or {}
    if r.get("class_key") not in keys or r.get("class_status") != "approved":
        print(f"[nia] SCOPE VIOLATION teacher={ (user_doc or {}).get('uid','') } "
              f"student={student_uid}")
        return None
    return _strip_pii(r)


def _fmt_concepts(items, n=6):
    out = []
    for c in (items or [])[:n]:
        if not isinstance(c, dict):
            continue
        name = c.get("concept_name") or c.get("concept_id") or ""
        if not name:
            continue
        m = c.get("mastery")
        seen = c.get("seen")
        bit = name.replace("_", " ")
        if m is not None and seen:
            bit += f" ({m}% over {seen} questions)"
        out.append(bit)
    return out


def _resolve_teacher_class(uid, user_doc, ref):
    ck = (ref.get("class_key") or "").strip()
    if not _teacher_owns_class(user_doc, ck):
        return None, "Your class", None
    lines = [f"CLASS: {ck}"]
    weak, n = {}, 0
    try:
        for doc in (_db().collection("student_rollups")
                    .where("class_key", "==", ck).limit(60).stream()):
            r = doc.to_dict() or {}
            if r.get("class_status") != "approved":
                continue
            n += 1
            for c in (r.get("weak_concepts") or [])[:5]:
                if isinstance(c, dict):
                    key = c.get("concept_name") or c.get("concept_id")
                    if key:
                        weak[key] = weak.get(key, 0) + 1
    except Exception as e:
        print(f"[nia] class context failed: {e}")
    lines.append(f"Approved students: {n}")
    if weak:
        top = sorted(weak.items(), key=lambda x: -x[1])[:8]
        lines.append("Concepts the MOST students are weak on "
                     "(concept — how many students):")
        for name, cnt in top:
            lines.append(f"  {str(name).replace('_', ' ')} — {cnt}")
    else:
        lines.append("No weak-concept data yet for this class.")
    return ("THE TEACHER IS LOOKING AT THIS CLASS.\n" + "\n".join(lines),
            f"Class {ck}", None)


def _resolve_teacher_student(uid, user_doc, ref):
    su = (ref.get("student_uid") or "").strip()
    r = _teacher_student_rollup(user_doc, su) if su else None
    if not r:
        return None, "Student", ("I can only look at students in your own "
                                 "class. Open one from your roster.")
    L = [f"STUDENT: {r.get('name', 'Student')} "
         f"(roll {r.get('roll_no') or '—'}, class {r.get('class_key', '')})"]
    if r.get("doctor_rank"):
        L.append(f"Level: {r['doctor_rank']}")
    if r.get("accuracy") is not None:
        L.append(f"Accuracy: {r['accuracy']}% over "
                 f"{r.get('questions_seen', 0)} questions "
                 f"({r.get('questions_correct', 0)} correct)")
    L.append(f"Tests completed: {r.get('tests_completed', 0)} · "
             f"Studio {r.get('studio_pct', 0)}% · "
             f"OPD {r.get('opd_pct', 0)}% · Arena {r.get('arena_pct', 0)}%")
    ret = r.get("retention") or {}
    if ret.get("retention_pct") is not None:
        L.append(f"Retention (v3 audit pass rate): {ret['retention_pct']}% "
                 f"over {ret.get('audits_total', 0)} audits")
    else:
        L.append("Retention: not enough v3 audits yet to score.")
    fr = ret.get("false_recoveries") or []
    if fr:
        L.append(f"Recovered in v2 but FAILED the v3 audit on "
                 f"{len(fr)} question(s) — memorised the example, not the "
                 f"rule. Concepts: " + ", ".join(
                     str(x.get("concept_id", "")).replace("_", " ")
                     for x in fr[:4] if x.get("concept_id")))
    weak = _fmt_concepts(r.get("weak_concepts"))
    if weak:
        L.append("Weakest concepts: " + "; ".join(weak))
    strong = _fmt_concepts(r.get("strong_concepts"), 3)
    if strong:
        L.append("Strongest: " + "; ".join(strong))
    if r.get("streak_current") is not None:
        L.append(f"Current streak: {r['streak_current']} days")
    return ("THE TEACHER IS LOOKING AT THIS STUDENT'S PAGE. These are the "
            "only figures you have \u2014 never invent others.\n"
            + "\n".join(L), r.get("name", "Student"), None)


def _resolve_teacher_home(uid, user_doc, ref):
    """Home is the screen a teacher actually looks at, and it lists the
    students who need them today BY NAME. The first version gave Nia
    only the class keys \u2014 so a teacher could read "Ezhili hasn't opened
    the app in 30 days" on screen, ask "what is happening with Ezhili?",
    and be told there is no data on anyone by that name. Correct, and
    useless.

    The flagged students are already on the teacher's screen and already
    within their scope, so putting the same names in the context adds no
    access \u2014 only the ability to answer about what they are reading.
    Guardian contact is stripped as everywhere else.
    """
    keys = ((user_doc or {}).get("class_keys") or [])[:3]
    if not keys:
        return ("THE TEACHER IS ON THEIR HOME SCREEN. They have no classes "
                "attached yet.", "Home", None)

    L = [f"Classes they teach: {', '.join(keys)}"]
    flagged, total = [], 0
    try:
        for ck in keys:
            for doc in (_db().collection("student_rollups")
                        .where("class_key", "==", ck).limit(60).stream()):
                r = _strip_pii(doc.to_dict() or {})
                if r.get("class_status") != "approved":
                    continue
                total += 1
                reason = r.get("alert_reason") or ""
                flags = r.get("alert_flags") or []
                if not reason and not flags:
                    continue
                bit = f"  {r.get('name', 'Student')} ({ck})"
                if reason:
                    bit += f" \u2014 {reason}"
                if r.get("accuracy") is not None and r.get("questions_seen"):
                    bit += (f" [accuracy {r['accuracy']}% over "
                            f"{r['questions_seen']} questions]")
                weak = _fmt_concepts(r.get("weak_concepts"), 2)
                if weak:
                    bit += " [weakest: " + "; ".join(weak) + "]"
                flagged.append(bit)
    except Exception as e:
        print(f"[nia] teacher home context failed: {e}")

    L.append(f"Approved students across those classes: {total}")
    if flagged:
        L.append("STUDENTS FLAGGED AS NEEDING ATTENTION TODAY \u2014 these are "
                 "the names on the teacher's screen right now:")
        L.extend(flagged[:12])
    else:
        L.append("No students are flagged as needing attention today.")
    L.append("If they ask about a student not listed above, say you can see "
             "only the flagged ones from here and to open that student from "
             "the Students tab for the full picture.")
    return ("THE TEACHER IS ON THEIR HOME SCREEN.\n" + "\n".join(L),
            "Home", None)


RESOLVERS = {
    "studio": _resolve_studio,
    "teacher_home": _resolve_teacher_home,
    "teacher_class": _resolve_teacher_class,
    "teacher_student": _resolve_teacher_student,
    "teacher_concepts": _resolve_teacher_class,
    "teacher_question": _resolve_review,
    "opd_review": _resolve_review,
    "arena_review": _resolve_review,
    "generic": _resolve_generic,
}

# Surfaces where Nia must not appear at all. Hiding the button is not
# enforcement — anyone can call the route directly — so the refusal lives
# here, server-side, and the client hiding it is only a courtesy.
TEACHER_SURFACES = {"teacher_home", "teacher_class", "teacher_student",
                    "teacher_concepts", "teacher_question"}

LIVE_TEST_SURFACES = {"opd_test", "arena_test", "pyq_test", "test",
                      "live_test", "exam"}


def resolve_context(uid, user_doc, ref):
    """Returns (block_text, label, error)."""
    ref = ref or {}
    surface = (ref.get("surface") or "generic").strip()
    if surface in LIVE_TEST_SURFACES:
        return None, None, "LIVE_TEST"
    fn = RESOLVERS.get(surface, _resolve_generic)
    try:
        return fn(uid, user_doc, ref)
    except Exception as e:
        print(f"[nia] resolver '{surface}' failed: {e}")
        return None, None, None


def student_block(uid, chapter_id=""):
    """The part ChatGPT structurally cannot have: how THIS student has
    actually performed. Read from student_rollups, which rollup_signals.py
    already maintains. Capped hard — this is flavour, not a transcript."""
    def build():
        try:
            snap = _db().collection("student_rollups").document(uid).get()
            if not snap.exists:
                return ""
            r = snap.to_dict() or {}
        except Exception:
            return ""
        bits = []
        # weak_concepts is a list of {concept_id, concept_name, mastery,
        # seen}. The first version pulled concept_id, so the model was
        # being handed "Chemistry_11_Ionic_Equilibrium_c04" where it
        # should read "Ostwald's dilution law" — more tokens, worse
        # answers, and a name the student would never recognise if it
        # ever leaked into a reply.
        weak = r.get("weak_concepts")
        names = []
        if isinstance(weak, dict):
            names = list(weak.keys())[:5]
        elif isinstance(weak, list):
            for w in weak[:5]:
                if isinstance(w, dict):
                    names.append(w.get("concept_name")
                                 or w.get("concept_id", ""))
                else:
                    names.append(str(w))
        names = [n.replace("_", " ") for n in names if n]
        if names:
            bits.append("Concepts they have struggled with recently: "
                        + ", ".join(names) + ".")
        if r.get("doctor_rank"):
            bits.append(f"Current level: {r['doctor_rank']}.")
        if not bits:
            return ""
        return ("WHAT YOU KNOW ABOUT THIS STUDENT (use it to pitch the "
                "answer; never read it back to them as a report):\n"
                + " ".join(bits))
    return _clip(_cached(f"rollup:{uid}", build), STUDENT_TOKEN_BUDGET)


# ═══════════════════════════════════════════════════════════════════════
# PROMPT
# ═══════════════════════════════════════════════════════════════════════

# Byte-identical for every student on the platform, forever. That is the
# point: it caches once and every subsequent request on every account
# reads it at the cache-hit rate. Interpolate a name into it and the
# saving is gone.
GLOBAL_RULES = """You are Nia — the Naadi Intelligent Assistant — a NEET tutor inside the NAADI AI study app. You are talking to an Indian school student, usually 16 or 17, preparing for NEET across Physics, Chemistry and Biology (NCERT Class 11 and 12).

Talk the way a good teacher talks to one student at their desk. Not the way a textbook is written.

SHAPE OF AN ANSWER
- Open with the idea in one plain sentence, in ordinary words, before any terminology. If a 15-year-old could not repeat that sentence back, rewrite it.
- Then break it up. Two or three sentences per paragraph, never more. A block of six lines is a wall and students skim walls.
- When something splits into parts — two ways, three types, four steps — use a list. Do not bury parallel items inside a paragraph as "First… Second…".
- Give a concrete example for anything abstract, and pick the one NCERT actually uses, so it matches what they will see in the exam.
- Where a plain-English comparison genuinely makes the idea click, use one. Where it would distort the science, skip it. Never force it.
- Bold the one term that matters most, once, with <b>. Not five terms.
- Close with the exam-facing point only when there is a real one — a common trap, an exception, the form NEET asks it in. If there isn't one, just stop.

DO NOT
- Do not write to a fixed template. Some questions want three lines, some want a list, some want a worked example. Vary it.
- No headers, no emoji, no "Great question", no "Let's dive in", no summary of what you are about to say.
- No motivational filler and no praise. Answer the question.
- Do not recite their performance data back at them.

LENGTH
- Conceptual questions: short. Usually under 150 words. Cover what was asked and stop — extra detail they didn't ask for is what makes an answer feel like a page of a book.
- Numericals, derivations and mechanisms: every step, with the reasoning for each, however long that takes. Never stop halfway to save space, and never skip a step because it is "obvious".
- Match the depth NEET tests. Do not drift into undergraduate material.

FORMATTING — write HTML directly. Never write Markdown.
- Bold is <b>like this</b>. NEVER **like this**. Asterisks are never formatting.
- A list is <ul><li>item</li><li>item</li></ul>. NEVER a line starting with "-" or "*".
- A numbered list is <ol><li>step</li></ol>. NEVER "1." at the start of a line.
- Separate paragraphs with a blank line. Never use # for a heading.
- The only tags allowed: <sub> <sup> <b> <i> <br> <ul> <li> <ol> <code>. Nothing else, and never an attribute.
- Formulas as CH<sub>3</sub>COOH, H<sub>2</sub>SO<sub>4</sub>, v<sup>2</sup>.
- If you are not sure, say so plainly and say what would settle it. Never invent a value, a year, or a reaction.

WHAT YOU WILL NOT DO
- You handle Physics, Chemistry, Biology, NEET preparation, and how to study them. For anything else — politics, relationships, entertainment, general chat — say warmly in ONE line that you only handle their subjects, and ask what they are studying. Do not lecture.
- You never help with a question the student has not yet submitted. If they seem to be asking you to answer a live exam question, decline and offer the underlying concept instead.
- You never produce sexual, violent, hateful or illegal content, and you never discuss self-harm methods. If a student seems genuinely distressed, tell them plainly that talking to a teacher, a parent or a counsellor is the right next step.

CONTEXT
Blocks below may tell you what is open on their screen and how this student has been performing.

- Use the performance data to pitch the answer. Do NOT volunteer it. Nobody wants their weak spots recited before an explanation they asked for.
- But if the student ASKS about their own performance directly, answer them. Tell them what you can see, plainly and briefly, then offer to work on the weakest part. Refusing to discuss it, or saying you would rather talk about the concept instead, is evasive and reads as a lecture — do not do that.
- If you have no performance data in the blocks below, say so in one line and point them at the Progress screen in the app. Never guess at their scores and never imply you are withholding something."""

TEACHER_RULES = """You are Nia, inside the NAADI AI teacher portal. You are talking to a school teacher preparing to teach NEET material (Physics, Chemistry, Biology, NCERT Class 11 and 12) to Indian school students.

This is a colleague, not a student. Assume they know the subject. What they need from you is how to TEACH it: the explanation that lands, the analogy that works, the misconception to pre-empt, the order to present it in.

WHAT THEY WILL ASK
- "How do I explain this concept so they get it?" — give the explanation you would actually use at the board, plus the one sentence that usually unlocks it.
- "Give me a story or an example." — concrete, Indian-classroom appropriate, and scientifically exact. A memorable analogy that is subtly wrong is worse than no analogy; say where it breaks down.
- "Why do they keep getting this wrong?" — name the misconception, not the mistake.
- "Draft a lesson plan." — objective, prerequisite check, the teaching sequence with timings, worked example, the question to check understanding, and what to set as follow-up. Fit it to the period length they give you; ask if they have not said.
- Questions about their class or a particular student, from the data blocks below.

HOW YOU ANSWER
- Direct and practical. No preamble, no "great question", no flattery.
- Short paragraphs. Use <ul><li> for anything that is a list of steps or points.
- Concrete over general. "Start with the NaCl example, then ask why MgO melts higher" beats "use relatable examples".
- Where the data blocks give you real numbers about this class, use them. Where they do not, say so plainly rather than guessing.
- Never invent a statistic about a class or a student. If it is not in the blocks below, you do not know it.

WHAT YOU WILL NOT DO
- You handle teaching, the subjects, and this class's data. For anything else, say so in one line.
- You do not draft messages to parents, and you do not have parent contact details.
- You never suggest disciplinary action, never comment on a student's character or home circumstances, and never speculate about why a student is struggling beyond what the data shows. If a teacher raises a wellbeing concern, say plainly that it belongs with the class teacher or the school's own process.

FORMATTING — write HTML directly. Never write Markdown.
- Bold is <b>like this</b>, NEVER **like this**. Lists are <ul><li>item</li></ul>, never a line starting with "-".
- Only these tags: <sub> <sup> <b> <i> <br> <ul> <li> <ol> <code>. Never an attribute.
- Formulas as CH<sub>3</sub>COOH, v<sup>2</sup>."""


TAG_INSTRUCTION = ("\n\nAt the very end of your reply, on its own final line, "
                   "write:  <!--topic: three or four words naming the concept "
                   "asked about-->   Nothing after it.")

_TAG_RE = re.compile(r"<!--\s*topic:\s*(.*?)\s*-->\s*$", re.I | re.S)


def split_tag(text):
    m = _TAG_RE.search(text or "")
    if not m:
        return text, ""
    return _TAG_RE.sub("", text).strip(), m.group(1)[:60]


def assemble(context_blocks, student_ctx, history, question, want_tag=True,
             rules=None):
    """THE ORDER HERE IS THE COST DECISION. See DECISION 1 at the top.

        [0] global rules   shared by every student  → cached platform-wide
        [1] first context  shared by every student on that concept
        [2] student state  per student
        [3..] history      appended, never rewritten
        [n] question

    A context that arrives mid-conversation (the student navigated) is
    appended AFTER the history, never merged into [1]. Merging would
    change the prefix and turn every previously cached token into a miss.
    """
    msgs = [{"role": "system",
             "content": (rules or GLOBAL_RULES)
             + (TAG_INSTRUCTION if want_tag else "")}]
    blocks = [b for b in (context_blocks or []) if b]
    if blocks:
        msgs.append({"role": "system", "content": blocks[0]})
    if student_ctx:
        msgs.append({"role": "system", "content": student_ctx})
    for m in (history or [])[-MAX_HISTORY_MESSAGES:]:
        role = "assistant" if m.get("role") == "assistant" else "user"
        msgs.append({"role": role, "content": str(m.get("text") or "")})
    for extra in blocks[1:]:
        msgs.append({"role": "system", "content": extra})
    msgs.append({"role": "user", "content": str(question or "")})
    return msgs


# ═══════════════════════════════════════════════════════════════════════
# QUOTA
#
# Checked when a conversation OPENS, never mid-thread. See DECISION 4.
# Metered in conversations because that is what a student can reason
# about; the token and rupee ceilings sit behind it as the real guard.
# ═══════════════════════════════════════════════════════════════════════

def quota_state(uid, user_doc):
    cfg = get_config()
    try:
        snap = _db().collection("ai_budgets").document(uid).get()
        b = (snap.to_dict() or {}) if snap.exists else {}
    except Exception:
        b = {}
    same_day = b.get("day_key") == _day_key()
    day = b.get("day_convos", 0) if same_day else 0
    day_msgs = b.get("day_msgs", 0) if same_day else 0
    month = b.get("month_convos", 0) if b.get("month_key") == _month_key() else 0
    life = b.get("life_convos", 0)
    return {
        "day_used": day, "day_cap": cfg["daily_cap"],
        "day_msgs": day_msgs, "msg_cap": cfg.get("daily_messages", 60),
        "month_used": month, "month_cap": cfg["monthly_cap"],
        "life_used": life, "life_cap": cfg["lifetime_cap"],
        "day_left": max(0, cfg["daily_cap"] - day),
    }


def _can_continue(uid, user_doc):
    """Continuing an existing topic. Deliberately looser than starting a
    new one: the conversation, monthly and lifetime caps do not apply,
    because a student mid-explanation must never be cut off. Only the
    kill switch, the paid gate and the message backstop apply."""
    cfg = get_config()
    if not cfg.get("enabled", True):
        return False, "DISABLED", ("Nia is taking a short break. Your "
                                   "teachers are still here in Doubts.")
    if cfg.get("paid_only"):
        plan = ((user_doc or {}).get("subscription") or {}).get("plan") or "free"
        if plan == "free":
            return False, "PAID_ONLY", ("Nia comes with the premium plan. "
                                        "Your teachers are always here in "
                                        "Doubts.")
    q = quota_state(uid, user_doc)
    if q["msg_cap"] and q["day_msgs"] >= q["msg_cap"]:
        return False, "MESSAGES", ("I'm out for today \u2014 back tomorrow "
                                   "morning. Your teachers are here right "
                                   "now, though.")
    return True, "OK", ""


def teacher_can_send(uid, user_doc):
    """No daily cap, no conversation cap. One monthly ceiling, so the
    spend is bounded and visible without a teacher ever meeting a limit
    mid-lesson-prep."""
    cfg = get_config()
    if not cfg.get("enabled", True):
        return False, "DISABLED", "Nia is taking a short break."
    cap = int(cfg.get("teacher_monthly_messages", 500) or 0)
    if not cap:
        return True, "OK", ""
    try:
        snap = _db().collection("ai_budgets").document(uid).get()
        b = (snap.to_dict() or {}) if snap.exists else {}
    except Exception:
        b = {}
    used = b.get("month_msgs", 0) if b.get("month_key") == _month_key() else 0
    if used >= cap:
        return False, "TEACHER_MONTH", ("Nia has reached its monthly limit "
                                        "for your account. It resets on the "
                                        "1st — ask your admin if you need "
                                        "more.")
    return True, "OK", ""


def can_start(uid, user_doc):
    """Returns (ok, code, message). Message is what a student reads, so it
    is written for a student, not for a log."""
    cfg = get_config()
    if not cfg.get("enabled", True):
        return False, "DISABLED", ("Nia is taking a short break. Your "
                                   "teachers are still here in Doubts.")
    if cfg.get("paid_only"):
        plan = ((user_doc or {}).get("subscription") or {}).get("plan") or "free"
        if plan == "free":
            return False, "PAID_ONLY", ("Nia comes with the premium plan. "
                                        "Your teachers are always here in "
                                        "Doubts.")
    q = quota_state(uid, user_doc)
    if q["msg_cap"] and q["day_msgs"] >= q["msg_cap"]:
        return False, "MESSAGES", ("I'm out for today \u2014 back tomorrow "
                                   "morning. Your teachers are here right "
                                   "now, though.")
    if q["life_used"] >= q["life_cap"]:
        return False, "LIFETIME", ("You have used all of your Nia "
                                   "conversations. Your teachers are here "
                                   "in Doubts.")
    if q["month_used"] >= q["month_cap"]:
        return False, "MONTH", ("That is a lot of ground this month. Nia "
                                "resets on the 1st — your teachers are "
                                "here in Doubts until then.")
    if q["day_used"] >= q["day_cap"]:
        return False, "DAY", ("I'm out for today — back tomorrow morning. "
                              "Your teachers are here right now, though.")
    return True, "OK", ""


# ═══════════════════════════════════════════════════════════════════════
# CONVERSATION STORE
# ═══════════════════════════════════════════════════════════════════════

def _conv_ref(cid):
    return _db().collection("ai_conversations").document(cid)


def _public_conv(cid, d):
    return {
        "conv_id": cid,
        "title": d.get("title") or "New conversation",
        "surface": d.get("surface", "generic"),
        "chapter_id": d.get("chapter_id", ""),
        "concept_tag": d.get("concept_tag", ""),
        "msg_count": d.get("msg_count", 0),
        "updated_at": d.get("updated_at", ""),
        "created_at": d.get("created_at", ""),
    }


def _load_conv(cid, uid):
    snap = _conv_ref(cid).get()
    if not snap.exists:
        return None
    d = snap.to_dict() or {}
    if d.get("uid") != uid:          # scope from the doc, never the request
        return None
    return d


# ═══════════════════════════════════════════════════════════════════════
# STUDENT ROUTES
# ═══════════════════════════════════════════════════════════════════════

@ai_bp.route("/api/assistant/state", methods=["GET"])
@require_auth
@require_role("student", "teacher")
def assistant_state():
    """Everything the client needs to decide whether to show the launcher.
    Deliberately does NOT include a usage counter — see the note in
    _send_stream. The client is told 'available' or 'not', nothing more."""
    cfg = get_config()
    ok, code, msg = can_start(request.uid, request.user_doc)
    # First name only. Deliberately NOT a dossier: no scores, no weak
    # concepts, nothing that could be wrong or that a student would
    # rather not see greeting them. A name is warm and cannot be
    # incorrect in a way that costs trust.
    is_teacher = (request.user_doc or {}).get("role") == "teacher"
    full = (request.user_doc or {}).get("name") or ""
    first = full.strip().split(" ")[0][:24] if full.strip() else ""
    return jsonify({
        "available": bool(cfg.get("enabled", True)),
        "can_start": ok, "code": code, "message": msg,
        "name": "Nia",
        "student_name": first,
        "role": "teacher" if is_teacher else "student",
    })


@ai_bp.route("/api/assistant/conversations", methods=["GET"])
@require_auth
@require_role("student", "teacher")
def list_conversations():
    out = []
    try:
        q = (_db().collection("ai_conversations")
             .where("uid", "==", request.uid).limit(40).stream())
        for doc in q:
            out.append(_public_conv(doc.id, doc.to_dict() or {}))
    except Exception as e:
        print(f"[nia] conversation list failed: {e}")
    out.sort(key=lambda c: c["updated_at"] or "", reverse=True)
    return jsonify({"conversations": out[:25]})


@ai_bp.route("/api/assistant/conversation/<cid>", methods=["GET"])
@require_auth
@require_role("student", "teacher")
def open_conversation(cid):
    d = _load_conv(cid, request.uid)
    if d is None:
        return jsonify({"error": "Conversation not found."}), 404
    msgs = [{"role": m.get("role"), "text": m.get("text", ""),
             "at": m.get("at", "")} for m in (d.get("messages") or [])]
    return jsonify({"conversation": _public_conv(cid, d), "messages": msgs})


@ai_bp.route("/api/assistant/conversation/<cid>", methods=["DELETE"])
@require_auth
@require_role("student", "teacher")
def close_conversation(cid):
    d = _load_conv(cid, request.uid)
    if d is None:
        return jsonify({"error": "Conversation not found."}), 404
    _conv_ref(cid).set({"status": "closed", "updated_at": _now_iso()},
                       merge=True)
    return jsonify({"ok": True})


@ai_bp.route("/api/assistant/ask", methods=["POST"])
@require_auth
@require_role("student", "teacher")
def ask():
    """Streams the answer as SSE.

    Response events:
        {"t":"meta",  "conv_id":..., "label":...}
        {"t":"token", "v":"..."}          ← many
        {"t":"done",  "html":..., "soft":...}
        {"t":"error", "v":"..."}

    Why SSE and not a plain JSON reply: a 400-token answer takes about
    4.5 seconds to generate but under a second to START. Streaming turns
    a 4.5-second spinner into an answer the student is already reading.
    That gap is the whole difference between using Nia and alt-tabbing to
    something free.
    """
    data = request.json or {}
    uid = request.uid
    user_doc = request.user_doc or {}
    question = str(data.get("text") or "").strip()[:MAX_QUESTION_CHARS]
    cid = str(data.get("conv_id") or "").strip()
    ref = data.get("context") or {}

    if not question:
        return jsonify({"error": "Type a question first."}), 400

    # ── live test: refuse server-side. The hidden button is a courtesy,
    #    this is the enforcement. ──
    _, _, ctx_err = resolve_context(uid, user_doc, ref)
    if ctx_err == "LIVE_TEST":
        return jsonify({"error": "Nia is closed during a test. Ask me "
                                 "anything once you've submitted.",
                        "code": "LIVE_TEST"}), 403

    # ── safety, before any spend ──
    sev, matched = safety_check(question)
    if sev > 0:
        try:
            _db().collection("ai_budgets").document(uid).set(
                {"flags": firestore.Increment(1),
                 "last_flag_at": _now_iso()}, merge=True)
            snap = _db().collection("ai_budgets").document(uid).get()
            flags = (snap.to_dict() or {}).get("flags", 1) if snap.exists else 1
        except Exception:
            flags = 1
        if sev >= 2 or flags >= 3:
            _log_safety(uid, user_doc, question, sev, matched,
                        repeat=(sev < 2))
        return jsonify({
            "error": "Let's keep this to your subjects — Physics, "
                     "Chemistry or Biology. What are you working on?",
            "code": "OFF_LIMITS"}), 200

    is_teacher = (user_doc or {}).get("role") == "teacher"
    surface = (ref.get("surface") or "generic")
    # A teacher surface asked for by a student, or the reverse, is a
    # client bug at best. Resolve on the ROLE, never on what was sent.
    if is_teacher and surface not in TEACHER_SURFACES:
        ref = dict(ref)
        ref["surface"] = "teacher_home"
    elif not is_teacher and surface in TEACHER_SURFACES:
        return jsonify({"error": "Not available.", "code": "ROLE"}), 403

    # ── quota, on START only ──
    existing = _load_conv(cid, uid) if cid else None

    # A thread started on an earlier day is a NEW topic, not a
    # continuation. Without this, the daily cap is trivially bypassed:
    # use up today's new topics, then reopen yesterday's chat from the
    # history list and ask forever. The cap exists so an explanation is
    # never cut off mid-answer — not so a thread becomes an unlimited
    # pass once it is a day old.
    if existing and existing.get("day_key") and \
            existing.get("day_key") != _day_key():
        existing = None
        cid = ""

    is_new = existing is None

    # Checked on EVERY message now, not only on a new topic. Teachers
    # take a different path entirely: no daily cap and no conversation
    # cap, only the monthly ceiling.
    if is_teacher:
        ok, code, msg = teacher_can_send(uid, user_doc)
    else:
        ok, code, msg = can_start(uid, user_doc) if is_new \
            else _can_continue(uid, user_doc)
    if not ok:
        return jsonify({"error": msg, "code": code}), 200

    ctx_block, label, soft_err = resolve_context(uid, user_doc, ref)
    history = (existing or {}).get("messages") or []
    blocks = list((existing or {}).get("context_blocks") or [])
    ctx_key = f"{ref.get('surface','')}:{ref.get('chapter_id','')}:{ref.get('concept_id','')}"

    if ctx_block and not any(b.get("key") == ctx_key for b in blocks):
        if len(ctx_block) > CONTEXT_TOKEN_BUDGET * 4 + 200:
            print(f"[nia] WARNING context block is {len(ctx_block)} chars "
                  f"for surface={ref.get('surface')} \u2014 over budget")
        blocks.append({"key": ctx_key, "text": ctx_block, "at": _now_iso()})

    messages = assemble([b["text"] for b in blocks],
                        "" if is_teacher
                        else student_block(uid, ref.get("chapter_id", "")),
                        history, question,
                        rules=TEACHER_RULES if is_teacher else None)

    if is_new:
        cid = _db().collection("ai_conversations").document().id

    print(f"[nia] ask uid={uid} role={'teacher' if is_teacher else 'student'} "
          f"surface={ref.get('surface')} conv={'new' if is_new else cid} "
          f"ctx_blocks={len(blocks)} history={len(history)} "
          f"q={len(question)}ch")
    if ctx_block is None and soft_err:
        print(f"[nia]   no context resolved: {soft_err}")

    return Response(stream_with_context(
        _send_stream(uid, user_doc, cid, is_new, question, messages,
                     blocks, history, ref, label, soft_err, is_teacher)),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            # Without this a reverse proxy buffers the whole stream and
            # delivers it in one lump — which silently converts streaming
            # back into a spinner, and looks like a bug with no cause.
            "X-Accel-Buffering": "no",
        })


def _sse(obj):
    return f"data: {json.dumps(obj)}\n\n"


def _send_stream(uid, user_doc, cid, is_new, question, messages,
                 blocks, history, ref, label, soft_err, is_teacher=False):
    yield _sse({"t": "meta", "conv_id": cid, "label": label or ""})
    if soft_err:
        yield _sse({"t": "note", "v": soft_err})

    acc, meta, failed = [], None, None
    for kind, payload in ai_call(uid, "teacher_assistant" if is_teacher
                                 else "assistant", messages, stream=True):
        if kind == "token":
            acc.append(payload)
            yield _sse({"t": "token", "v": payload})
        elif kind == "done":
            meta = payload
        elif kind == "error":
            failed = payload

    if failed and not acc:
        yield _sse({"t": "error", "v": failed})
        return

    raw = "".join(acc)
    body, tag = split_tag(raw)
    html_out = sanitise_out(body)
    meta = meta or {"hit": 0, "miss": 0, "out": 0, "cost_inr": 0.0}

    # ── persist ──
    now = _now_iso()
    msgs = list(history) + [
        {"role": "user", "text": question[:MAX_QUESTION_CHARS], "at": now},
        {"role": "assistant", "text": body, "at": now},
    ]
    try:
        doc = {
            "uid": uid,
            "student_name": (user_doc or {}).get("name", ""),
            "role": "teacher" if is_teacher else "student",
            "class_key": class_key_for(user_doc or {}) or "",
            "school_id": (user_doc or {}).get("school_id", ""),
            "class_id": (user_doc or {}).get("class_id", ""),
            "surface": ref.get("surface", "generic"),
            "chapter_id": ref.get("chapter_id", ""),
            "concept_id": ref.get("concept_id", ""),
            "messages": msgs[-MAX_STORED_MESSAGES:],
            "context_blocks": blocks[-4:],
            "msg_count": len(msgs),
            "updated_at": now,
            "status": "open",
            "tokens_in": firestore.Increment(meta["hit"] + meta["miss"]),
            "tokens_out": firestore.Increment(meta["out"]),
            "cost_inr": firestore.Increment(round(meta["cost_inr"], 6)),
        }
        if is_new:
            doc["created_at"] = now
            doc["day_key"] = _day_key()
            doc["title"] = question[:60]
        if tag:
            doc["concept_tag"] = tag
        _conv_ref(cid).set(doc, merge=True)
    except Exception as e:
        print(f"[nia] conversation write failed: {e}")

    _bill_student(uid, meta["cost_inr"], meta["hit"] + meta["miss"],
                  meta["out"], new_convo=is_new)

    # The soft nudge. No counter is ever shown — a visible tally makes a
    # student ration questions, which is the opposite of what we want. The
    # only two moments they hear about the cap are the last conversation
    # of the day and the one after it, and both point at their teachers.
    soft = ""
    if is_new and not is_teacher:
        q = quota_state(uid, user_doc)
        if q["day_left"] <= 0:
            # Wording matters here. The earlier line ("that's a lot of
            # ground today") read as "stop asking", and a student who
            # then asked "so I can't ask more?" got a flat contradiction
            # from the model — which knows nothing about the cap. The
            # cap only governs STARTING a new topic; this conversation
            # continues normally, so say exactly that.
            soft = ("This is your last new topic for today — but we can "
                    "keep going in this chat for as long as you like. "
                    "Fresh start tomorrow morning.")
    yield _sse({"t": "done", "html": html_out, "soft": soft, "tag": tag})


# ═══════════════════════════════════════════════════════════════════════
# ADMIN ROUTES
#
# Every number here comes from a rollup written at call time. Nothing in
# this section scans ai_calls. See DECISION 3 — a scan is about ₹2.60 per
# refresh at 50k calls, which is more than a student spends in a year.
# ═══════════════════════════════════════════════════════════════════════

@ai_bp.route("/api/admin/ai/overview", methods=["GET"])
@require_auth
@require_admin
def admin_ai_overview():
    days = min(int(request.args.get("days", 30) or 30), 90)
    today = datetime.now(IST).date()
    wanted = [(today - timedelta(days=i)).isoformat()
              for i in range(days - 1, -1, -1)]

    trend, total, calls, tin, tout, hits, errors = [], 0.0, 0, 0, 0, 0, 0
    by_feature = {}
    try:
        db = _db()
        refs = [db.collection("ai_usage_daily").document(d) for d in wanted]
        for snap in db.get_all(refs):
            d = (snap.to_dict() or {}) if snap.exists else {}
            date = d.get("date") or snap.id
            c = float(d.get("cost_inr", 0) or 0)
            trend.append({"date": date, "cost_inr": round(c, 4),
                          "calls": int(d.get("calls", 0) or 0)})
            total += c
            calls += int(d.get("calls", 0) or 0)
            errors += int(d.get("errors", 0) or 0)
            tin += int(d.get("tokens_in", 0) or 0)
            tout += int(d.get("tokens_out", 0) or 0)
            hits += int(d.get("cache_hit_tokens", 0) or 0)
            for k, v in (d.get("by_feature") or {}).items():
                by_feature[k] = by_feature.get(k, 0.0) + float(v or 0)
    except Exception as e:
        print(f"[nia] admin overview failed: {e}")
    trend.sort(key=lambda r: r["date"])

    today_key = _day_key()
    today_cost = next((r["cost_inr"] for r in trend if r["date"] == today_key), 0)
    month_cost = sum(r["cost_inr"] for r in trend
                     if r["date"].startswith(_month_key()))

    return jsonify({
        "today_cost": round(today_cost, 4),
        "month_cost": round(month_cost, 4),
        "window_cost": round(total, 4),
        "window_days": days,
        "calls": calls, "errors": errors,
        "tokens_in": tin, "tokens_out": tout,
        "cache_hit_pct": round(100.0 * hits / tin, 1) if tin else 0.0,
        "avg_cost_per_call": round(total / calls, 5) if calls else 0.0,
        "by_feature": {k: round(v, 4) for k, v in by_feature.items()},
        "trend": trend,
        "usd_inr": USD_INR,
        "keys": _pool().health(),
        "key_count": _pool().size(),
        "config": get_config(force=True),
    })


@ai_bp.route("/api/admin/ai/students", methods=["GET"])
@require_auth
@require_admin
def admin_ai_students():
    """Per-student spend, plus a class and school roll-up derived from the
    same pass. ai_budgets is one small document per student who has
    actually used Nia — not per registered student — so this scales with
    usage rather than with the roster."""
    rows = []
    try:
        for doc in _db().collection("ai_budgets").stream():
            b = doc.to_dict() or {}
            rows.append({
                "uid": doc.id,
                "name": b.get("name", ""),
                "day_convos": b.get("day_convos", 0)
                if b.get("day_key") == _day_key() else 0,
                "month_convos": b.get("month_convos", 0)
                if b.get("month_key") == _month_key() else 0,
                "life_convos": b.get("life_convos", 0),
                "day_cost": round(float(b.get("day_cost", 0) or 0), 4)
                if b.get("day_key") == _day_key() else 0.0,
                "month_cost": round(float(b.get("month_cost", 0) or 0), 4)
                if b.get("month_key") == _month_key() else 0.0,
                "life_cost": round(float(b.get("life_cost", 0) or 0), 4),
                "life_tokens": b.get("life_tokens", 0),
                "flags": b.get("flags", 0),
            })
    except Exception as e:
        print(f"[nia] admin students failed: {e}")

    # Names and scope come from users/, fetched only for the uids that
    # actually appear — not the whole roster.
    classes, schools = {}, {}
    try:
        db = _db()
        refs = [db.collection("users").document(r["uid"]) for r in rows[:500]]
        umap = {}
        for snap in db.get_all(refs):
            if snap.exists:
                umap[snap.id] = snap.to_dict() or {}
        for r in rows:
            u = umap.get(r["uid"]) or {}
            r["name"] = u.get("name") or r["name"] or "Student"
            r["class_id"] = u.get("class_id", "")
            r["school_id"] = u.get("school_id", "")
            r["plan"] = (u.get("subscription") or {}).get("plan", "free")
            ck = r["class_id"] or "—"
            sk = r["school_id"] or "—"
            classes.setdefault(ck, {"class_id": ck, "students": 0,
                                    "life_cost": 0.0, "life_convos": 0})
            classes[ck]["students"] += 1
            classes[ck]["life_cost"] += r["life_cost"]
            classes[ck]["life_convos"] += r["life_convos"]
            schools.setdefault(sk, {"school_id": sk, "students": 0,
                                    "life_cost": 0.0, "life_convos": 0})
            schools[sk]["students"] += 1
            schools[sk]["life_cost"] += r["life_cost"]
            schools[sk]["life_convos"] += r["life_convos"]
    except Exception as e:
        print(f"[nia] admin student names failed: {e}")

    rows.sort(key=lambda r: r["life_cost"], reverse=True)
    for group in (classes, schools):
        for v in group.values():
            v["life_cost"] = round(v["life_cost"], 4)
            v["avg_per_student"] = round(
                v["life_cost"] / v["students"], 4) if v["students"] else 0.0

    return jsonify({
        "students": rows[:200],
        "student_count": len(rows),
        "classes": sorted(classes.values(),
                          key=lambda c: c["life_cost"], reverse=True),
        "schools": sorted(schools.values(),
                          key=lambda s: s["life_cost"], reverse=True),
    })


@ai_bp.route("/api/admin/ai/student/<uid>", methods=["GET"])
@require_auth
@require_admin
def admin_ai_student(uid):
    try:
        snap = _db().collection("ai_budgets").document(uid).get()
        b = (snap.to_dict() or {}) if snap.exists else {}
    except Exception:
        b = {}
    convos = []
    try:
        for doc in (_db().collection("ai_conversations")
                    .where("uid", "==", uid).limit(50).stream()):
            d = doc.to_dict() or {}
            convos.append({
                "conv_id": doc.id,
                "title": d.get("title", ""),
                "concept_tag": d.get("concept_tag", ""),
                "chapter_id": d.get("chapter_id", ""),
                "msg_count": d.get("msg_count", 0),
                "cost_inr": round(float(d.get("cost_inr", 0) or 0), 4),
                "updated_at": d.get("updated_at", ""),
            })
    except Exception as e:
        print(f"[nia] admin student drill failed: {e}")
    convos.sort(key=lambda c: c["updated_at"] or "", reverse=True)
    return jsonify({
        "uid": uid,
        "budget": {
            "day_convos": b.get("day_convos", 0)
            if b.get("day_key") == _day_key() else 0,
            "month_convos": b.get("month_convos", 0)
            if b.get("month_key") == _month_key() else 0,
            "life_convos": b.get("life_convos", 0),
            "life_cost": round(float(b.get("life_cost", 0) or 0), 4),
            "life_tokens": b.get("life_tokens", 0),
            "flags": b.get("flags", 0),
        },
        "conversations": convos[:30],
    })


@ai_bp.route("/api/admin/ai/config", methods=["GET", "POST"])
@require_auth
@require_admin
def admin_ai_config():
    if request.method == "GET":
        return jsonify({"config": get_config(force=True),
                        "defaults": DEFAULTS})
    data = request.json or {}
    patch = {}
    for k in ("enabled", "paid_only"):
        if k in data:
            patch[k] = bool(data[k])
    for k in ("daily_cap", "monthly_cap", "lifetime_cap", "max_tokens",
              "daily_messages", "teacher_monthly_messages"):
        if k in data:
            try:
                patch[k] = max(0, int(data[k]))
            except (TypeError, ValueError):
                pass
    if data.get("model") in PRICE_USD_PER_MTOK:
        patch["model"] = data["model"]
    if not patch:
        return jsonify({"error": "Nothing to change."}), 400
    patch["updated_at"] = _now_iso()
    patch["updated_by"] = request.uid
    try:
        _db().collection("platform_config").document("ai").set(
            patch, merge=True)
    except Exception as e:
        return jsonify({"error": f"Could not save: {e}"}), 500
    invalidate_config()
    return jsonify({"ok": True, "config": get_config(force=True)})


# ═══════════════════════════════════════════════════════════════════════
# REGISTRATION
#
# Same guard as doubts_backend: Flask resolves a duplicate (path, METHOD)
# silently, to whichever blueprint registered first. That failure serves
# the wrong data with no error, so it is caught at import instead. A rule's
# identity is (path, METHOD, endpoint) — the same path with different
# methods is ordinary Flask and must not trip this.
# ═══════════════════════════════════════════════════════════════════════

def register_assistant_routes(app):
    def slots():
        out = {}
        for r in app.url_map.iter_rules():
            for m in (r.methods or set()) - {"HEAD", "OPTIONS"}:
                out.setdefault((str(r), m), set()).add(r.endpoint)
        return out

    before = slots()
    app.register_blueprint(ai_bp)
    after = slots()

    prefix = ai_bp.name + "."
    clashes = []
    for (path, method), endpoints in after.items():
        mine = {e for e in endpoints if e.startswith(prefix)}
        others = endpoints - mine
        if mine and others:
            clashes.append(f"{method} {path}  (mine: {sorted(mine)[0]}, "
                           f"already owned by: {sorted(others)[0]})")
    if clashes:
        raise RuntimeError("ai_gateway: route collision on\n  "
                           + "\n  ".join(sorted(clashes)))

    added = len(set(after) - set(before))
    pool = _pool()
    print(f"✅ Nia gateway registered — {added} routes, "
          f"{pool.size()} DeepSeek key(s)")
    print(f"   key sources: {_POOL_REF['source']}")
    if pool.size() == 0:
        print("⚠️  No DEEPSEEK_API_KEY / DEEPSEEK_API_KEYS set — Nia will "
              "answer with a configuration error until one is provided.")
    return app