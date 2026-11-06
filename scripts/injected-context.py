"""Context Claude Code injects on its own (attachments, meta messages) and what carrying it costs.

Record sizes are an upper bound on the rendered text. Each injected block is written to the prompt cache once, then re-read on every later main-thread call until
the next compaction. Costs are base-input-token equivalents (read 0.1x, 1h write 2x, 5m write 1.25x,
output 5x) as a share of total main-thread spend. Also reports the fixed per-call share of N tokens.

usage: python3 -I scripts/injected-context.py [days] [cwd-prefix]
"""

import collections
import glob
import json
import os
import sys
import time

DAYS = float(sys.argv[1]) if len(sys.argv) > 1 else 5
PREFIX = sys.argv[2] if len(sys.argv) > 2 else os.path.expanduser("~/code")
since = time.time() - DAYS * 86400

total_ite = 0.0
calls_n = 0
cost = collections.Counter()
count = collections.Counter()
tokens_added = collections.Counter()

for f in glob.glob(os.path.expanduser("~/.claude/projects/*/*.jsonl")):
    if os.path.getmtime(f) < since:
        continue
    sid = os.path.basename(f)[:-6]
    seen = set()
    events = []  # ("call", None) | ("compact", None) | ("inject", (kind, tokens))
    cwd_ok = None
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
            a = d.get("attachment") or {}
            # Bookkeeping, not shown to the model: the prefix snapshot (counted as fixed per-call cost) and tool-input tracking.
            if a.get("type") in ("prompt_snapshot", "deferred_tools_record"):
                continue
            events.append(("inject", ("attach:" + a.get("type", "?"), len(json.dumps(a)) / 4)))
        elif t == "user" and d.get("isMeta"):
            c = d["message"]["content"]
            text = c if isinstance(c, str) else json.dumps(c)
            events.append(("inject", ("meta:" + text[:28].split("\n")[0], len(text) / 4)))
        elif t == "system" and d.get("subtype") == "compact_boundary":
            events.append(("compact", None))
        elif t == "assistant":
            m = d.get("message") or {}
            u = m.get("usage")
            if not u or m.get("model") == "<synthetic>" or m.get("id") in seen:
                continue
            seen.add(m.get("id"))
            cc = u.get("cache_creation") or {}
            w1h = cc.get("ephemeral_1h_input_tokens", 0) or 0
            w = u.get("cache_creation_input_tokens", 0) or 0
            ite = 0.1 * (u.get("cache_read_input_tokens", 0) or 0) + 2 * w1h + 1.25 * (w - w1h) + (u.get("input_tokens", 0) or 0) + 5 * (u.get("output_tokens", 0) or 0)
            events.append(("call", ite))
    if not cwd_ok:
        continue
    # Carry each injected block forward until the next compaction.
    for i, (kind, val) in enumerate(events):
        if kind == "call":
            total_ite += val
            calls_n += 1
            continue
        if kind != "inject":
            continue
        name, toks = val
        carried = 0
        for k2, _ in events[i + 1:]:
            if k2 == "compact":
                break
            if k2 == "call":
                carried += 1
        if carried == 0:
            continue
        cost[name] += toks * (2 + 0.1 * (carried - 1))
        count[name] += 1
        tokens_added[name] += toks

pct = lambda x: f"{100 * x / total_ite:.1f}%"
print(f"scope: {calls_n} main-thread calls, last {DAYS:g}d, cwd {PREFIX}")
print(f"injected context, total: {pct(sum(cost.values()))} of spend")
for name, c in cost.most_common(14):
    print(f"  {name:44} n={count[name]:6}  ~{int(tokens_added[name] / max(1, count[name])):6} tok each  {pct(c)}")
print(f"\na fixed 10k tokens on every main call (tool definitions, system prompt) = {pct(0.1 * 10_000 * calls_n)} of spend")
