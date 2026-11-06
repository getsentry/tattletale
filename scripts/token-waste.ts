// What made context expensive without adding value: duplicate tool outputs, failed calls, MCP boilerplate,
// the heaviest single outputs, and model calls the agents never wrote to the transcript.
//
// A tool output costs: written once to the prompt cache, then re-read on every later call in the same
// thread until a compaction. Costs are in base-input-token equivalents (ITE): read 0.1x, 5m write 1.25x,
// 1h write 2x, output 5x (Anthropic multipliers, Opus-class), reported as a share of total spend.
//
// usage: node --no-warnings scripts/token-waste.ts [days] [cwd-prefix]

import { createHash } from "node:crypto";
import { listClaudeSessions } from "../src/claude.ts";
import { listCodexSessions } from "../src/codex.ts";
import type { ModelCall, Session, ToolCall } from "../src/model.ts";
import { parseSession } from "../src/sync.ts";
import { asString } from "../src/util.ts";

const DAYS = Number(process.argv[2] ?? 5);
const PREFIX = process.argv[3] ?? `${process.env.HOME}/code`;
const since = Date.now() - DAYS * 86_400_000;

const callIte = (c: ModelCall) => {
  const u = c.usage!;
  const w1h = u.extra?.cache_write_1h ?? 0;
  const w5 = u.cacheWrite - w1h;
  return 0.1 * u.cacheRead + 1.25 * w5 + 2 * w1h + (u.input - u.cacheRead - u.cacheWrite) + 5 * u.output;
};

interface Thread {
  session: Session;
  main: boolean;
  calls: ModelCall[];
  tools: ToolCall[];
}
const threads: Thread[] = [];
const seenCalls = new Set<string>();
const seenTools = new Set<string>();
const keep =
  <T extends { id: string }>(seen: Set<string>) =>
  (x: T) =>
    seen.has(x.id) ? false : (seen.add(x.id), true);
for (const path of listClaudeSessions(since)) {
  const s = parseSession(path, "claude-code", { final: true });
  if (!s.cwd?.startsWith(PREFIX)) continue;
  threads.push({
    session: s,
    main: true,
    calls: s.turns
      .flatMap((t) => t.calls)
      .filter((c) => c.usage && !c.sidechain)
      .filter(keep(seenCalls)),
    tools: s.turns.flatMap((t) => t.tools).filter(keep(seenTools)),
  });
  for (const r of s.subagents)
    threads.push({
      session: s,
      main: false,
      calls: r.calls.filter((c) => c.usage).filter(keep(seenCalls)),
      tools: r.tools.filter(keep(seenTools)),
    });
}

let total = 0;
for (const th of threads) for (const c of th.calls) total += callIte(c);
const pct = (x: number) => `${((100 * x) / total).toFixed(1)}%`;

/** ITE cost of keeping `tokens` in this thread from the tool's result until the next compaction. */
function costOf(th: Thread, t: ToolCall, tokens: number): { cost: number; carried: number } {
  const i = th.calls.findIndex((c) => c.start >= (t.end ?? t.start) - 1);
  if (i < 0) return { cost: 0, carried: 0 };
  let carried = 0;
  for (let j = i; j < th.calls.length; j++) {
    if (j > i && th.calls[j]!.analysis?.compactedBefore) break;
    carried++;
  }
  return { cost: tokens * ((th.main ? 2 : 1.25) + 0.1 * Math.max(0, carried - 1)), carried };
}

const group = (name: string) => (name.startsWith("mcp__") ? `mcp:${name.split("__")[1]}` : name);
const detail = (t: ToolCall) => {
  const a = (t.arguments ?? {}) as any;
  return String(a.command ?? a.file_path ?? a.query ?? a.url ?? a.pattern ?? "")
    .replace(/\s+/g, " ")
    .slice(0, 70);
};

const byGroup = new Map<string, { n: number; cost: number }>();
const dupes = new Map<string, { n: number; cost: number }>();
const errors = new Map<string, { n: number; cost: number }>();
const heaviest: { cost: number; tokens: number; carried: number; name: string; detail: string }[] = [];
const resultsByTool = new Map<string, { th: Thread; t: ToolCall; text: string }[]>();
let toolCost = 0;

for (const th of threads) {
  th.calls.sort((a, b) => a.start - b.start);
  const seenOut = new Set<string>();
  for (const t of th.tools) {
    if (t.result === undefined || t.resultBytes === undefined) continue;
    const text = asString(t.result);
    const tokens = t.resultBytes / 4;
    const { cost, carried } = costOf(th, t, tokens);
    toolCost += cost;
    const g = group(t.name);
    const gv = byGroup.get(g) ?? { n: 0, cost: 0 };
    gv.n++;
    gv.cost += cost;
    byGroup.set(g, gv);
    heaviest.push({ cost, tokens, carried, name: t.name, detail: detail(t) });
    const key = `${t.name}\u0000${createHash("sha1").update(text).digest("hex")}`;
    if (seenOut.has(key) && tokens > 25) {
      const dv = dupes.get(g) ?? { n: 0, cost: 0 };
      dv.n++;
      dv.cost += cost;
      dupes.set(g, dv);
    }
    seenOut.add(key);
    if (t.isError) {
      const ev = errors.get(g) ?? { n: 0, cost: 0 };
      ev.n++;
      ev.cost += cost;
      errors.set(g, ev);
    }
    if (t.name.startsWith("mcp__")) {
      const list = resultsByTool.get(t.name) ?? [];
      list.push({ th, t, text });
      resultsByTool.set(t.name, list);
    }
  }
}

// MCP boilerplate: lines that show up in most results of the same tool (headers, hints, "next steps").
const boiler: { tool: string; n: number; lines: number; bytesPerResult: number; cost: number; sample: string }[] = [];
for (const [tool, list] of resultsByTool) {
  if (list.length < 5) continue;
  const freq = new Map<string, number>();
  for (const { text } of list)
    for (const line of new Set(
      text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 20),
    ))
      freq.set(line, (freq.get(line) ?? 0) + 1);
  const common = [...freq.entries()].filter(([, n]) => n >= list.length * 0.6).map(([l]) => l);
  if (!common.length) continue;
  let cost = 0;
  let bytes = 0;
  for (const { th, t, text } of list) {
    const b = common.filter((l) => text.includes(l)).reduce((n, l) => n + l.length + 1, 0);
    bytes += b;
    cost += costOf(th, t, b / 4).cost;
  }
  boiler.push({
    tool,
    n: list.length,
    lines: common.length,
    bytesPerResult: Math.round(bytes / list.length),
    cost,
    sample: common.toSorted((a, b) => b.length - a.length)[0]!.slice(0, 90),
  });
}

const sum = (m: Map<string, { cost: number }>) => [...m.values()].reduce((n, v) => n + v.cost, 0);
console.log(
  `scope: ${threads.filter((t) => t.main).length} sessions, ${threads.length - threads.filter((t) => t.main).length} subagent runs, ${seenCalls.size} model calls, last ${DAYS}d, cwd ${PREFIX}`,
);
console.log(`tool outputs in context: ${pct(toolCost)} of spend (written once, re-read until compaction)`);
console.log("\nby tool group (share of spend):");
for (const [g, v] of [...byGroup.entries()].toSorted((a, b) => b[1].cost - a[1].cost).slice(0, 10))
  console.log(`  ${g.padEnd(40)} n=${String(v.n).padStart(6)}  ${pct(v.cost)}`);
console.log(`\nduplicate outputs (same tool, byte-identical result earlier in the thread): ${pct(sum(dupes))}`);
for (const [g, v] of [...dupes.entries()].toSorted((a, b) => b[1].cost - a[1].cost).slice(0, 6))
  console.log(`  ${g.padEnd(40)} n=${String(v.n).padStart(5)}  ${pct(v.cost)}`);
console.log(`\nfailed tool calls (error text kept in context): ${pct(sum(errors))}`);
for (const [g, v] of [...errors.entries()].toSorted((a, b) => b[1].cost - a[1].cost).slice(0, 6))
  console.log(`  ${g.padEnd(40)} n=${String(v.n).padStart(5)}  ${pct(v.cost)}`);
console.log(
  `\nMCP boilerplate (lines repeated in >=60% of a tool's results): ${pct(boiler.reduce((n, b) => n + b.cost, 0))}`,
);
for (const b of boiler.toSorted((a, z) => z.cost - a.cost).slice(0, 6))
  console.log(`  ${b.tool.padEnd(44)} n=${b.n} ~${b.bytesPerResult}B/result ${pct(b.cost)}  e.g. "${b.sample}"`);
console.log("\nheaviest single outputs:");
for (const h of heaviest.toSorted((a, b) => b.cost - a.cost).slice(0, 8))
  console.log(
    `  ${pct(h.cost).padStart(5)}  ${Math.round(h.tokens / 1000)}k tok x ${h.carried} calls  ${h.name}  ${h.detail}`,
  );

// Model calls the agents never wrote down.
console.log("\nhidden calls:");
let codexTotal = 0;
let codexHidden = 0;
let codexHiddenN = 0;
let codexSessions = 0;
for (const path of listCodexSessions(0)) {
  const s = parseSession(path, "codex", { final: true });
  const calls = s.turns.flatMap((t) => t.calls).filter((c) => c.usage);
  if (!calls.length) continue;
  codexSessions++;
  for (const c of calls) {
    const cost = callIte(c);
    codexTotal += cost;
    if (c.hidden) {
      codexHidden += cost;
      codexHiddenN++;
    }
  }
}
console.log(
  `  Codex (all ${codexSessions} local sessions): ${codexHiddenN} calls with usage but no persisted output = ${((100 * codexHidden) / codexTotal).toFixed(1)}% of Codex spend`,
);
let csRef = 0;
let csSeen = 0;
const sideModels = new Map<string, number>();
for (const th of threads.filter((t) => t.main)) {
  const ref = th.session.reference?.claudeCostState;
  if (!ref) continue;
  const seen = threads.filter((t) => t.session === th.session).flatMap((t) => t.calls);
  for (const [model, u] of Object.entries(ref)) {
    const r = 0.1 * u.cacheRead + 2 * u.cacheWrite + (u.input - u.cacheRead - u.cacheWrite) + 5 * u.output;
    const mine = seen.filter((c) => c.model === model).reduce((n, c) => n + callIte(c), 0);
    csRef += r;
    csSeen += Math.min(mine, r);
    if (r > mine * 1.01) sideModels.set(model, (sideModels.get(model) ?? 0) + (r - mine));
  }
}
if (csRef)
  console.log(
    `  Claude Code (sessions with a cost-state record): ${((100 * (csRef - csSeen)) / csRef).toFixed(1)}% of what Claude Code counted never appears in the transcript; by model: ${[...sideModels.entries()].map(([m, v]) => `${m} ${((100 * v) / csRef).toFixed(1)}%`).join(", ")}`,
  );
