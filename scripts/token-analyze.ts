// Token-savings analysis over the same parsed sessions that were sent to Sentry (~/code, last N days).
import { listClaudeSessions } from "../src/claude.ts";
import { listCodexSessions } from "../src/codex.ts";
import type { Compaction, ModelCall, Session, ToolCall } from "../src/model.ts";
import { parseSession } from "../src/sync.ts";

const DAYS = Number(process.argv[2] ?? 5);
// $/token as priced by Sentry for claude-opus-5-5 (derived from this week's gen_ai.cost.* sums).
const P = {
  read: 490.97582633 / 2_451_634_495,
  write: 109.11907750000003 / 21_813_679,
  out: 115.13953100000003 / 5_752_426,
};

const PREFIX = process.argv[3] ?? `${process.env.HOME}/code`;
const since = Date.now() - DAYS * 86_400_000;
const paths = [
  ...listClaudeSessions(since).map((p) => ({ p, a: "claude-code" as const })),
  ...listCodexSessions(since).map((p) => ({ p, a: "codex" as const })),
];

interface Thread {
  session: Session;
  name: string;
  calls: ModelCall[];
  tools: ToolCall[];
  compactions: Compaction[];
}
const threads: Thread[] = [];
for (const { p, a } of paths) {
  const s = parseSession(p, a, { final: true });
  if (!s.cwd?.startsWith(PREFIX)) continue;
  threads.push({
    session: s,
    name: "main",
    calls: s.turns.flatMap((t) => t.calls).filter((c) => !c.sidechain && c.usage),
    tools: s.turns.flatMap((t) => t.tools),
    compactions: s.turns.flatMap((t) => t.compactions),
  });
  for (const r of s.subagents)
    threads.push({
      session: s,
      name: r.agentType,
      calls: r.calls.filter((c) => c.usage),
      tools: r.tools,
      compactions: r.compactions,
    });
}

const add = (m: Map<string, any>, k: string, f: (v: any) => void, init: () => any) => {
  if (!m.has(k)) m.set(k, init());
  f(m.get(k));
};
const byTool = new Map<string, any>();
const byMcp = new Map<string, any>();
const reads = new Map<string, any>();
let carriedAll = 0;
let totalRead = 0,
  totalWrite = 0,
  totalOut = 0,
  totalIn = 0,
  calls = 0;
const breaks = { n: 0, write: 0, idleOver1h: 0, idle5mTo1h: 0, idleUnder5m: 0, writeOver1h: 0 };
const baseline = { tokens: 0, calls: 0 };
const big = { over400k: 0, tokensOver200k: 0 };
let compactions = 0,
  preTokens = 0;
const subagentRuns = new Map<string, any>();

// Belt and braces: count each call/tool once even if two sessions hold a rewritten copy.
const seenCalls = new Set<string>(),
  seenTools = new Set<string>();
for (const th of threads) {
  th.calls = th.calls.filter((c) => (seenCalls.has(c.id) ? false : (seenCalls.add(c.id), true)));
  th.tools = th.tools.filter((t) => (seenTools.has(t.id) ? false : (seenTools.add(t.id), true)));
}
for (const th of threads) {
  th.calls.sort((a, b) => a.start - b.start);
  const first = th.calls[0];
  if (first && th.name === "main") {
    baseline.tokens += first.usage!.input * th.calls.length;
    baseline.calls += th.calls.length;
  }
  for (const c of th.calls) {
    const u = c.usage!;
    calls++;
    totalIn += u.input;
    totalRead += u.cacheRead;
    totalWrite += u.cacheWrite;
    totalOut += u.output;
    if (u.input > 400_000) big.over400k++;
    big.tokensOver200k += Math.max(0, u.input - 200_000);
    const a = c.analysis;
    if (a?.cacheBreak) {
      breaks.n++;
      breaks.write += u.cacheWrite;
      const idle = (a.idleMs ?? 0) / 1000;
      if (idle > 3600) {
        breaks.idleOver1h++;
        breaks.writeOver1h += u.cacheWrite;
      } else if (idle > 300) breaks.idle5mTo1h++;
      else breaks.idleUnder5m++;
    }
  }
  if (th.name !== "main")
    add(
      subagentRuns,
      th.name,
      (v) => {
        v.runs++;
        v.write += th.calls.reduce((n, c) => n + c.usage!.cacheWrite, 0);
        v.read += th.calls.reduce((n, c) => n + c.usage!.cacheRead, 0);
        v.calls += th.calls.length;
      },
      () => ({ runs: 0, write: 0, read: 0, calls: 0 }),
    );
  compactions += th.compactions.length;
  preTokens += th.compactions.reduce((n, c) => n + (c.preTokens ?? 0), 0);
  for (const t of th.tools) {
    if (t.resultBytes === undefined || t.end === undefined) continue;
    const tokens = t.resultBytes / 4;
    const consumer = th.calls.findIndex((c) => c.start >= t.end! - 1);
    if (consumer < 0) continue;
    const cut = Math.min(...th.compactions.filter((c) => c.end > t.end!).map((c) => c.end), Infinity);
    let carried = 0;
    for (let i = consumer; i < th.calls.length && th.calls[i]!.start < cut; i++) carried++;
    const carriedTokens = tokens * carried;
    carriedAll += carriedTokens;
    const mcp = /^mcp__(.+?)__/.exec(t.name)?.[1];
    const key = mcp ? `mcp:${mcp}` : t.name;
    add(
      byTool,
      key,
      (v) => {
        v.n++;
        v.tokens += tokens;
        v.carried += carriedTokens;
        v.max = Math.max(v.max, tokens);
      },
      () => ({ n: 0, tokens: 0, carried: 0, max: 0 }),
    );
    if (mcp)
      add(
        byMcp,
        `${mcp}/${t.name.split("__")[2]}`,
        (v) => {
          v.n++;
          v.tokens += tokens;
          v.carried += carriedTokens;
        },
        () => ({ n: 0, tokens: 0, carried: 0 }),
      );
    const fp = (t.arguments as any)?.file_path;
    if (t.name === "Read" && typeof fp === "string")
      add(
        reads,
        `${th.session.sessionId}|${fp}`,
        (v) => {
          v.n++;
          v.tokens += tokens;
          v.carried += carriedTokens;
        },
        () => ({ n: 0, tokens: 0, carried: 0 }),
      );
  }
}

const $ = (n: number) => `$${n.toFixed(2)}`;
const M = (n: number) => `${(n / 1e6).toFixed(1)}M`;
console.log(
  `scope: ${threads.filter((t) => t.name === "main").length} sessions, ${threads.length} threads, ${calls} calls, last ${DAYS}d, cwd ~/code`,
);
console.log(
  `input ${M(totalIn)} (read ${M(totalRead)}, write ${M(totalWrite)}), output ${M(totalOut)}; ~cost read ${$(totalRead * P.read)} write ${$(totalWrite * P.write)} out ${$(totalOut * P.out)}`,
);
console.log(
  `\nbaseline (first-call context: system prompt + tools + CLAUDE.md) re-read on every main call: ${M(baseline.tokens)} tokens = ${((100 * baseline.tokens) / totalIn).toFixed(0)}% of input, ~${$(baseline.tokens * P.read)}`,
);
console.log(
  `calls with >400k input: ${big.over400k}; input above 200k across all calls: ${M(big.tokensOver200k)} (~${$(big.tokensOver200k * P.read)} at cache-read price)`,
);
console.log(
  `compactions: ${compactions}, avg pre-compaction context ${compactions ? Math.round(preTokens / compactions / 1000) : 0}k`,
);
console.log(
  `cache breaks: ${breaks.n} (idle>1h ${breaks.idleOver1h}, 5m-1h ${breaks.idle5mTo1h}, <5m ${breaks.idleUnder5m}); cache writes on those calls ${M(breaks.write)} ~${$(breaks.write * P.write)} (after >1h idle: ${M(breaks.writeOver1h)} ~${$(breaks.writeOver1h * P.write)})`,
);
console.log(`\ntool results by tool: est tokens added | carried (re-read until compaction) | ~carried cost`);
for (const [k, v] of [...byTool.entries()].toSorted((a, b) => b[1].carried - a[1].carried).slice(0, 14))
  console.log(
    `  ${k.padEnd(34)} n=${String(v.n).padStart(5)}  added ${M(v.tokens).padStart(7)}  carried ${M(v.carried).padStart(8)}  ~${$(v.carried * P.read).padStart(8)}  max ${Math.round(v.max / 1000)}k`,
  );
console.log(`  (all tools carried ${M(carriedAll)} = ${((100 * carriedAll) / totalRead).toFixed(0)}% of cache reads)`);
console.log(`\ntop MCP tools by carried tokens:`);
for (const [k, v] of [...byMcp.entries()].toSorted((a, b) => b[1].carried - a[1].carried).slice(0, 8))
  console.log(`  ${k.padEnd(48)} n=${v.n}  added ${M(v.tokens)}  carried ${M(v.carried)}  ~${$(v.carried * P.read)}`);
const rereads = [...reads.values()].filter((v) => v.n > 1);
console.log(
  `\nre-reads: ${rereads.length} (session,file) pairs read 2+ times, ${rereads.reduce((n, v) => n + v.n - 1, 0)} extra reads, extra tokens added ${M(rereads.reduce((n, v) => n + v.tokens * (1 - 1 / v.n), 0))}`,
);
console.log(`\nsubagents: type | runs | calls | cache write share of input`);
for (const [k, v] of [...subagentRuns.entries()].toSorted((a, b) => b[1].read + b[1].write - (a[1].read + a[1].write)))
  console.log(
    `  ${k.padEnd(20)} runs=${v.runs} calls=${v.calls} write share=${((100 * v.write) / (v.read + v.write)).toFixed(0)}%  ~write cost ${$(v.write * P.write)}`,
  );
