"""Why the prompt cache breaks, and whether the 1h cache TTL pays off.

Walks Claude Code transcripts in order. For each model call (deduped by message.id, own lines only) it
records what happened since the previous call: attachments Claude Code injected (tool-list deltas, MCP
instruction changes, skill listings...), model switches, idle time. A call "breaks" the cache when its
cache reads drop by more than max(1024, 10%) of the previous call's without a compaction in between.

Costs are in base-input-token equivalents (ITE) using Anthropic's multipliers:
read 0.1x, 5m write 1.25x, 1h write 2x, output 5x (Opus-class).

usage: python3 -I scripts/cache-causes.py [days] [cwd-prefix]
"""

import collections
import glob
import json
import os
import sys
import time
from datetime import datetime

DAYS = float(sys.argv[1]) if len(sys.argv) > 1 else 5
PREFIX = sys.argv[2] if len(sys.argv) > 2 else os.path.expanduser("~/code")
since = time.time() - DAYS * 86400


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


calls_total = 0
breaks = []  # (idle_s, write_tokens, set(causes))
base = collections.Counter()  # cause -> calls where present
idle_hist = collections.Counter()
ite = collections.Counter()
unread_write_ite = 0.0
w5_total = w1h_total = 0

for f in glob.glob(os.path.expanduser("~/.claude/projects/*/*.jsonl")):
    if os.path.getmtime(f) < since:
        continue
    sid = os.path.basename(f)[:-6]
    prev = None  # dict(read, end, model, w1h, w5)
    seen_ids = set()
    pending = set()
    compacted = False
    cwd_ok = None
    cur = None
    for line in open(f):
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get("sessionId") not in (None, sid) or d.get("isSidechain"):
            continue
        if cwd_ok is None and d.get("cwd"):
            cwd_ok = d["cwd"].startswith(PREFIX)
        t = d.get("type")
        if t == "attachment":
            pending.add("attach:" + (d.get("attachment") or {}).get("type", "?"))
            continue
        if t == "system" and d.get("subtype") == "compact_boundary":
            compacted = True
            continue
        if t == "user":
            c = (d.get("message") or {}).get("content")
            if isinstance(c, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
                pending.add("tool_result")
            elif not d.get("isMeta"):
                pending.add("new_prompt")
            continue
        if t != "assistant":
            continue
        m = d.get("message") or {}
        u = m.get("usage")
        if not u or m.get("model") == "<synthetic>":
            continue
        mid = m.get("id")
        if mid in seen_ids:
            if cur is not None:
                cur["end"] = ts(d["timestamp"])
            continue
        seen_ids.add(mid)
        if cwd_ok is False:
            continue
        start = ts(d["timestamp"])
        read = u.get("cache_read_input_tokens", 0) or 0
        cc = u.get("cache_creation") or {}
        w1h = cc.get("ephemeral_1h_input_tokens", 0) or 0
        w5 = cc.get("ephemeral_5m_input_tokens", 0) or 0
        write = u.get("cache_creation_input_tokens", 0) or 0
        if not cc:
            w5 = write
        fresh = u.get("input_tokens", 0) or 0
        out = u.get("output_tokens", 0) or 0
        calls_total += 1
        w5_total += w5
        w1h_total += w1h
        ite["read"] += 0.1 * read
        ite["write_5m"] += 1.25 * w5
        ite["write_1h"] += 2.0 * w1h
        ite["fresh"] += fresh
        ite["output"] += 5.0 * out
        causes = set(pending)
        if prev:
            idle = max(0.0, start - prev["end"])
            idle_hist["<5m" if idle < 300 else "5m-1h" if idle < 3600 else ">1h"] += 1
            if prev["model"] != m.get("model"):
                causes.add("model_switch")
            causes.add("idle>1h" if idle >= 3600 else "idle5m-1h" if idle >= 300 else "idle<5m")
            for c_ in causes:
                base[c_] += 1
            drop = prev["read"] - read
            if not compacted and drop > max(1024, 0.1 * prev["read"]):
                breaks.append((idle, write, causes, 1.25 * w5 + 2.0 * w1h - 0.1 * write))
            if idle >= 3600:
                unread_write_ite += 1.25 * prev["w5"] + 2.0 * prev["w1h"]
        cur = {"read": read, "end": start, "model": m.get("model"), "w1h": w1h, "w5": w5}
        prev = cur
        pending = set()
        compacted = False
    if prev:  # the last write of a session is never read again
        unread_write_ite += 1.25 * prev["w5"] + 2.0 * prev["w1h"]

total_ite = sum(ite.values())
pct = lambda x: f"{100 * x / total_ite:.1f}%"
print(f"scope: {calls_total} main-thread calls, last {DAYS:g}d, cwd {PREFIX}")
print("cost split (ITE): " + ", ".join(f"{k} {pct(v)}" for k, v in ite.most_common()))
print(f"idle gaps between calls: {dict(idle_hist)}")

brk_ite = sum(b[3] for b in breaks)
print(f"\ncache breaks: {len(breaks)} calls, extra cost vs a cache hit {pct(brk_ite)} of spend")
cause_n = collections.Counter()
cause_ite = collections.Counter()
for idle, write, causes, cost in breaks:
    for c_ in causes:
        cause_n[c_] += 1
        cause_ite[c_] += cost
print("  cause present before the break | breaks | break rate when present | share of break cost")
for c_, n in cause_n.most_common(14):
    rate = n / base[c_] if base[c_] else 0
    print(f"  {c_:34} {n:5}   {100 * rate:5.1f}% of {base[c_]:6}   {100 * cause_ite[c_] / brk_ite:5.1f}%")

print(f"\ncache writes never read (last write before >1h idle or session end): {pct(unread_write_ite)} of spend")
# 1h vs 5m TTL: 1h costs 0.75x extra per written token; it saves re-writing the prefix on 5m-1h gaps.
premium = 0.75 * w1h_total
print(f"1h TTL premium paid on {w1h_total / 1e6:.1f}M written tokens: {pct(premium)} of spend; gaps it bridges: {idle_hist['5m-1h']} calls")
