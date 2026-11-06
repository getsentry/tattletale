// Local reconciliation. Never sends anything. Each check compares the parser against an independent,
// deliberately naive reading of the raw transcript, then the built spans against the parser.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeUsage } from "./claude.ts";
import { codexUsage, hasTaskStarted } from "./codex.ts";
import type { AgentName, Usage } from "./model.ts";
import { addUsage, sumCalls } from "./model.ts";
import { buildSpans, spanAttr } from "./spans.ts";
import { detectAgent, parseSession } from "./sync.ts";
import { jsonlRecords, num } from "./util.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
  warnOnly?: boolean;
}

export interface VerifyResult {
  path: string;
  agent: AgentName;
  sessionId: string;
  ok: boolean;
  checks: Check[];
  usage?: Usage;
  spans: number;
  /** message/response IDs this session owns, for the cross-file duplicate check. */
  ownedCallIds: string[];
}

const fields: (keyof Usage)[] = ["input", "cacheRead", "cacheWrite", "output"];
const fmt = (u: Usage | undefined) =>
  u ? `in=${u.input} read=${u.cacheRead} write=${u.cacheWrite} out=${u.output}` : "none";

function sameUsage(a: Usage | undefined, b: Usage | undefined): boolean {
  if (!a && !b) return true;
  return fields.every((f) => ((a?.[f] as number) ?? 0) === ((b?.[f] as number) ?? 0));
}

/** Last usage per message.id, across files (union), among lines the owner filter accepts. */
function naiveClaude(paths: string[], ownerId?: string): { usage?: Usage; ids: string[] } {
  const byId = new Map<string, any>();
  for (const path of paths) {
    for (const r of jsonlRecords(path)) {
      if (r?.type !== "assistant" || r.message?.model === "<synthetic>" || !r.message?.usage) continue;
      if (ownerId && path === paths[0] && r.sessionId !== ownerId) continue;
      // A fork can copy its parent's message mid-stream; usage only grows, so keep the largest.
      const id = r.message.id ?? r.uuid;
      const prev = byId.get(id);
      if (!prev || num(r.message.usage.output_tokens) >= num(prev.output_tokens)) byId.set(id, r.message.usage);
    }
  }
  let usage: Usage | undefined;
  for (const u of byId.values()) usage = addUsage(usage, claudeUsage(u));
  return { usage, ids: [...byId.keys()] };
}

export function verifyTranscript(path: string, agent: AgentName = detectAgent(path)): VerifyResult {
  const session = parseSession(path, agent, { final: true });
  const checks: Check[] = [];
  const mainCalls = session.turns.flatMap((t) => t.calls);
  const subCalls = session.subagents.flatMap((s) => s.calls);
  const parsedMain = sumCalls(mainCalls);
  const parsedAll = addUsage(parsedMain, sumCalls(subCalls));
  let ownedCallIds: string[] = [];

  if (agent === "claude-code") {
    const naiveMain = naiveClaude([path], session.sessionId);
    checks.push({
      name: "main usage = naive dedup-by-message.id",
      ok: sameUsage(parsedMain, naiveMain.usage),
      detail: `parsed ${fmt(parsedMain)} | naive ${fmt(naiveMain.usage)}`,
    });
    // Fork subagents copy their parent's history, so per-file sums overcount. The union of every file in
    // the session, deduped by message.id, is what the session really spent.
    const dir = join(dirname(path), session.sessionId, "subagents");
    const subFiles = session.subagents.map((r) => join(dir, `agent-${r.agentId}.jsonl`)).filter((f) => existsSync(f));
    const naiveAll = naiveClaude([path, ...subFiles], session.sessionId);
    ownedCallIds = naiveAll.ids;
    if (subFiles.length)
      checks.push({
        name: `session usage (main + ${subFiles.length} subagents) = naive union dedup`,
        ok: sameUsage(parsedAll, naiveAll.usage),
        detail: `parsed ${fmt(parsedAll)} | naive ${fmt(naiveAll.usage)}`,
      });
    const cs = session.reference?.claudeCostState;
    if (cs) {
      const ref = Object.values(cs).reduce<Usage | undefined>((acc, u) => addUsage(acc, { ...u }), undefined);
      const gap = ref && parsedAll ? ref.input + ref.output - (parsedAll.input + parsedAll.output) : undefined;
      checks.push({
        name: "Claude cost-state vs transcript (side calls not in transcript)",
        ok: true,
        warnOnly: true,
        detail: `cost-state ${fmt(ref)} | transcript ${fmt(parsedAll)} | gap ${gap}`,
      });
    }
  } else {
    const ref = session.reference?.cumulative;
    const withUnattributed = addUsage(parsedAll, session.diagnostics.unattributedUsage);
    if (ref)
      checks.push({
        name: "calls usage = cumulative token_count total",
        ok: sameUsage(withUnattributed, ref),
        detail: `parsed ${fmt(withUnattributed)} | cumulative ${fmt(ref)}`,
      });
    const records = new Map<string, any>();
    let own = !hasTaskStarted(path);
    for (const r of jsonlRecords(path)) {
      if (r?.type === "event_msg" && r.payload?.type === "task_started") own = true;
      if (own && r?.type === "token_usage_record")
        records.set(r.payload?.response_id ?? JSON.stringify(r), r.payload?.usage);
    }
    // Calls whose usage came from cumulative token_count deltas (no record) mean a mixed-format rollout.
    const mixed = records.size > 0 && session.turns.some((t) => t.calls.some((c) => c.usage && !records.has(c.id)));
    if (mixed)
      checks.push({
        name: "rollout mixes token_usage_record and token_count-only intervals",
        ok: true,
        warnOnly: true,
      });
    if (records.size && !mixed) {
      let naive: Usage | undefined;
      for (const u of records.values()) naive = addUsage(naive, codexUsage(u));
      checks.push({
        name: "calls usage = naive dedup-by-response_id",
        ok: sameUsage(parsedAll, naive),
        detail: `parsed ${fmt(parsedAll)} | naive ${fmt(naive)}`,
      });
      ownedCallIds = [...records.keys()];
    }
    if (session.diagnostics.unattributedUsage)
      checks.push({
        name: "no unattributed usage",
        ok: false,
        warnOnly: true,
        detail: fmt(session.diagnostics.unattributedUsage),
      });
  }

  const spans = buildSpans(session, { content: "full", environment: "verify" });
  const chats = spans.filter((s) => spanAttr(s, "gen_ai.operation.name") === "chat");
  const spanUsage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const s of chats) {
    spanUsage.input += Number(spanAttr(s, "gen_ai.usage.input_tokens") ?? 0);
    spanUsage.cacheRead += Number(spanAttr(s, "gen_ai.usage.cache_read.input_tokens") ?? 0);
    spanUsage.cacheWrite += Number(spanAttr(s, "gen_ai.usage.cache_creation.input_tokens") ?? 0);
    spanUsage.output += Number(spanAttr(s, "gen_ai.usage.output_tokens") ?? 0);
  }
  checks.push({
    name: "chat spans sum = parsed usage",
    ok: sameUsage(spanUsage, parsedAll ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }),
    detail: `spans ${fmt(spanUsage)}`,
  });

  const callCount = mainCalls.length + subCalls.length;
  const callIds = new Set([...mainCalls, ...subCalls].map((c) => c.id));
  checks.push({
    name: "one chat span per call, no duplicate call IDs",
    ok: chats.length === callCount && callIds.size === callCount,
    detail: `calls=${callCount} unique=${callIds.size} chatSpans=${chats.length}`,
  });

  const ids = new Set(spans.map((s) => s.spanId));
  const orphans = spans.filter((s) => s.parentSpanId && !ids.has(s.parentSpanId));
  checks.push({
    name: "every parent span exists",
    ok: orphans.length === 0,
    detail: orphans.length ? `${orphans.length} orphans, e.g. ${orphans[0]!.name}` : undefined,
  });

  let maxAttr = 0;
  for (const s of spans)
    for (const a of s.attributes) maxAttr = Math.max(maxAttr, Buffer.byteLength(a.value.stringValue ?? ""));
  checks.push({ name: "largest attribute < 128KB", ok: maxAttr < 128 * 1024, detail: `${maxAttr} bytes` });

  const multiIteration = [...mainCalls, ...subCalls].filter((c) => c.usage?.extra?.iterations).length;
  if (multiIteration)
    checks.push({
      name: "responses with >1 usage iteration (top-level usage assumed to be the total)",
      ok: false,
      warnOnly: true,
      detail: `${multiIteration} calls`,
    });
  const allTools = [...session.turns, ...session.subagents].flatMap((r) => r.tools);
  const unfinished = allTools.filter((t) => t.result === undefined && !t.serverSide).length;
  if (unfinished)
    checks.push({
      name: "all tool calls have results",
      ok: false,
      warnOnly: true,
      detail: `${unfinished}/${allTools.length} without result`,
    });

  const backwards = spans.filter((s) => BigInt(s.endTimeUnixNano) < BigInt(s.startTimeUnixNano)).length;
  checks.push({ name: "no span ends before it starts", ok: backwards === 0 });

  return {
    path,
    agent,
    sessionId: session.sessionId,
    ok: checks.every((c) => c.ok || c.warnOnly),
    checks,
    usage: parsedAll,
    spans: spans.length,
    ownedCallIds,
  };
}

/** Across sessions: each model call must be owned by exactly one session, or it would be counted twice. */
export function crossSessionDuplicates(results: VerifyResult[]): { id: string; sessions: string[] }[] {
  const owners = new Map<string, Set<string>>();
  for (const r of results)
    for (const id of r.ownedCallIds) (owners.get(id) ?? owners.set(id, new Set()).get(id)!).add(r.sessionId);
  return [...owners.entries()].filter(([, s]) => s.size > 1).map(([id, s]) => ({ id, sessions: [...s] }));
}
