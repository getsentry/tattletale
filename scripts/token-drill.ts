import { readFileSync } from "node:fs";
import { listClaudeSessions } from "../src/claude.ts";
import type { ModelCall, Session } from "../src/model.ts";
import { parseSession } from "../src/sync.ts";

const PREFIX = process.argv[3] ?? `${process.env.HOME}/code`;
const since = Date.now() - 5 * 86_400_000;
const seen = new Set<string>();
const sessions: { s: Session; title: string; calls: ModelCall[] }[] = [];
for (const p of listClaudeSessions(since)) {
  const s = parseSession(p, "claude-code", { final: true });
  if (!s.cwd?.startsWith(PREFIX)) continue;
  let title = "";
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.includes('"custom-title"') && !line.includes('"ai-title"')) continue;
    try {
      const r = JSON.parse(line);
      title = r.customTitle ?? r.aiTitle ?? r.title ?? title;
    } catch {}
  }
  const calls = s.turns
    .flatMap((t) => t.calls)
    .filter((c) => c.usage && !c.sidechain && !seen.has(c.id) && seen.add(c.id));
  sessions.push({ s, title, calls });
}

// Sentry's claude-opus-5-5 prices, derived from this week's gen_ai.cost.* sums.
const READ = 490.97582633 / 2_451_634_495;
const WRITE = 109.11907750000003 / 21_813_679;
const OUT = 115.13953100000003 / 5_752_426;
const cost = (cs: ModelCall[]) =>
  cs.reduce(
    (n, c) =>
      n +
      c.usage!.cacheRead * READ +
      c.usage!.cacheWrite * WRITE +
      c.usage!.output * OUT +
      (c.usage!.input - c.usage!.cacheRead - c.usage!.cacheWrite) * READ * 10,
    0,
  );

console.log("top sessions (main thread only):");
for (const x of [...sessions].toSorted((a, b) => cost(b.calls) - cost(a.calls)).slice(0, 4)) {
  const ins = x.calls.map((c) => c.usage!.input).toSorted((a, b) => a - b);
  const first = new Date(x.s.turns[0]!.start).toISOString().slice(5, 10);
  const last = new Date(x.s.turns.at(-1)!.end).toISOString().slice(5, 10);
  const compactions = x.s.turns.reduce((n, t) => n + t.compactions.length, 0);
  console.log(
    `  ${x.s.sessionId.slice(0, 8)} "${x.title}" turns=${x.s.turns.length} calls=${x.calls.length} ~$${cost(x.calls).toFixed(0)} median ctx ${Math.round(ins[ins.length >> 1]! / 1000)}k floor ${Math.round(ins[0]! / 1000)}k compactions=${compactions} ${first}..${last}`,
  );
}

let floorTok = 0;
let mainCalls = 0;
for (const x of sessions) {
  if (!x.calls.length) continue;
  const floor = Math.min(...x.calls.map((c) => c.usage!.input));
  floorTok += floor * x.calls.length;
  mainCalls += x.calls.length;
}
console.log(
  `\nfixed prompt floor (min context per session x its calls): ${(floorTok / 1e6).toFixed(0)}M tokens over ${mainCalls} main calls, avg ${Math.round(floorTok / mainCalls / 1000)}k/call, ~$${(floorTok * READ).toFixed(0)}`,
);

const cmd = new Map<string, { n: number; bytes: number }>();
for (const x of sessions) {
  for (const t of x.s.turns.flatMap((tt) => tt.tools)) {
    if (t.name !== "Bash") continue;
    let c = String((t.arguments as any)?.command ?? "").trim();
    const cd = c.match(/^cd \S+\s*(?:&&|;)\s*/);
    if (cd) c = c.slice(cd[0].length);
    const key = c.split(/\s+/).slice(0, 2).join(" ").slice(0, 40);
    const v = cmd.get(key) ?? { n: 0, bytes: 0 };
    v.n++;
    v.bytes += t.resultBytes ?? 0;
    cmd.set(key, v);
  }
}
console.log("\nBash by command (first two words): count, output");
for (const [k, v] of [...cmd.entries()].toSorted((a, b) => b[1].n - a[1].n).slice(0, 12))
  console.log(`  ${k.padEnd(40)} n=${v.n} out=${(v.bytes / 1e6).toFixed(1)}MB`);

const before = new Map<string, number>();
let within = 0;
let idleBreaks = 0;
for (const x of sessions) {
  const toolsByCall = new Map<string, string[]>();
  for (const t of x.s.turns.flatMap((tt) => tt.tools)) {
    const name = t.name.startsWith("mcp__") ? `mcp:${t.name.split("__")[1]}` : t.name;
    if (!toolsByCall.has(t.callId)) toolsByCall.set(t.callId, []);
    toolsByCall.get(t.callId)!.push(name);
  }
  for (let i = 1; i < x.calls.length; i++) {
    const c = x.calls[i]!;
    const a = c.analysis;
    if (!a?.cacheBreak) continue;
    if ((a.idleMs ?? 0) > 3_600_000) {
      idleBreaks++;
      continue;
    }
    within++;
    const prev = x.calls[i - 1]!;
    const names = new Set(toolsByCall.get(prev.id) ?? ["(no tool: new prompt)"]);
    if (prev.model !== c.model) names.add(`model switch ${prev.model}->${c.model}`);
    for (const n of names) before.set(n, (before.get(n) ?? 0) + 1);
  }
}
console.log(
  `\ncache breaks in main threads: ${within} within the 1h TTL, ${idleBreaks} after >1h idle. Tools in the call right before a within-TTL break:`,
);
for (const [k, v] of [...before.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, 10))
  console.log(`  ${k.padEnd(40)} ${v}`);
