// Codex rollouts: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl and ~/.codex/archived_sessions/*.jsonl[.zst].
//
// Facts this relies on (checked against real rollouts):
// - Newer builds write a `token_usage_record` per model response (with `response_id`): exact per-call usage.
// - Older builds only write `event_msg/token_count` with a cumulative `total_token_usage`, and repeat it
//   (rate-limit updates re-emit the same totals), so per-call usage = change in the cumulative total.
// - OpenAI-style `input_tokens` already includes cached and cache-write tokens (Sentry's convention).
// - Records before the first own `task_started` are inherited history (fork/compacted start).

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { analyzeThread } from "./analyze.ts";
import type { Compaction, Message, ModelCall, ParseOptions, Session, ToolCall, Turn, Usage } from "./model.ts";
import { addUsage, emptyDiagnostics, sumCalls } from "./model.ts";
import { asString, byteLength, countKey, hashHex, num, readJsonl, toMs } from "./util.ts";

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
/** A request can't plausibly wait this long between its last input and its first output. */
const MAX_WAIT_MS = 15 * 60 * 1000;
const OUTPUT_ITEMS = new Set([
  "reasoning",
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "web_search_call",
  "tool_search_call",
]);
const TOOL_OUTPUT_ITEMS = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "local_shell_call_output",
  "tool_search_output",
]);

export function codexUsage(u: any): Usage {
  return {
    input: num(u?.input_tokens),
    cacheRead: num(u?.cached_input_tokens),
    cacheWrite: num(u?.cache_write_input_tokens),
    output: num(u?.output_tokens),
    reasoning: num(u?.reasoning_output_tokens),
  };
}

function usageDelta(total: Usage, prev: Usage | undefined): Usage {
  if (!prev) return total;
  return {
    input: total.input - prev.input,
    cacheRead: total.cacheRead - prev.cacheRead,
    cacheWrite: total.cacheWrite - prev.cacheWrite,
    output: total.output - prev.output,
    reasoning: (total.reasoning ?? 0) - (prev.reasoning ?? 0),
  };
}

const sameUsage = (a: Usage | undefined, b: Usage | undefined): boolean =>
  !!a &&
  !!b &&
  a.input === b.input &&
  a.cacheRead === b.cacheRead &&
  a.cacheWrite === b.cacheWrite &&
  a.output === b.output &&
  (a.reasoning ?? 0) === (b.reasoning ?? 0);

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: any) => c?.text ?? (c?.type === "input_image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function toolOutput(raw: unknown): { text: string; error: boolean } {
  if (raw && typeof raw === "object") {
    const o = raw as any;
    return { text: asString(o.content ?? o.output ?? o), error: o.success === false };
  }
  return { text: asString(raw), error: false };
}

export function parseCodex(path: string, opts: ParseOptions = {}): Session {
  const now = opts.now ?? Date.now();
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const file = readJsonl(path);
  const fileId =
    basename(path).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)?.[1] ?? basename(path);
  const session: Session = {
    agent: "codex",
    sessionId: fileId,
    path,
    turns: [],
    subagents: [],
    diagnostics: emptyDiagnostics(),
  };
  session.diagnostics.badLines = file.badLines;
  const diag = session.diagnostics;

  // Rollouts switch format mid-session in both directions (different Codex builds resuming the same
  // thread), so the source of truth is decided per interval between two token_count events: if
  // token_usage_records were written in it they are exact and cover the delta; otherwise the cumulative
  // delta is the usage of the call(s) in that interval.
  let recordsSinceCount: Usage | undefined;
  const hasTaskStarted = file.records.some((r) => r?.type === "event_msg" && r.payload?.type === "task_started");
  let own = !hasTaskStarted;
  let provider = "openai";
  let model = "unknown";
  let turn: Turn | undefined;
  let open: ModelCall | undefined;
  let pendingInput: Message[] = [];
  let lastInputTs = 0;
  // Calls that finished without usage since the last cumulative token_count. Only these can own its
  // delta; older ones lost their usage for good and must not soak up a later response's tokens.
  let sinceCount: ModelCall[] = [];
  const tools = new Map<string, ToolCall>();
  const allCalls: ModelCall[] = [];
  const compactions: Compaction[] = [];
  let prevTotal: Usage | undefined;
  let baseline: Usage | undefined;
  let lastTs = 0;
  let compactionPending = false;

  const ensureTurn = (ts: number): Turn => {
    if (!turn) {
      turn = {
        id: `continuation:${fileId}`,
        index: session.turns.length,
        start: ts,
        end: ts,
        complete: false,
        trigger: "continuation",
        apiErrors: 0,
        calls: [],
        tools: [],
        compactions: [],
      };
      session.turns.push(turn);
    }
    return turn;
  };
  const closeOpen = () => {
    if (!open) return;
    if (!open.usage) sinceCount.push(open);
    open = undefined;
  };
  // A model response whose usage was recorded but whose output was never persisted. Real tokens, so it
  // gets its own call (with no messages) instead of disappearing.
  const hiddenCall = (usage: Usage, ts: number, responseId?: string) => {
    const t = ensureTurn(ts);
    const call: ModelCall = {
      id: responseId ?? hashHex(24, fileId, t.id, "hidden", String(t.calls.length)),
      start: Math.min(lastInputTs || ts, ts),
      end: ts,
      model,
      provider,
      usage,
      input: [],
      output: [],
      complete: true,
      hidden: true,
    };
    t.calls.push(call);
    allCalls.push(call);
  };
  const attribute = (usage: Usage, ts: number) => {
    // The delta covers responses finished since the previous token_count; the latest of them gets it.
    const target = open && !open.usage ? open : sinceCount.at(-1);
    if (target) {
      target.usage = usage;
      if (target === open) open = undefined;
    } else if (turn) {
      hiddenCall(usage, ts);
    } else {
      diag.unattributedUsage = addUsage(diag.unattributedUsage, usage);
    }
  };

  for (const rec of file.records) {
    const type = rec?.type;
    const p = rec?.payload ?? {};
    const ts = toMs(rec?.timestamp) ?? lastTs;
    lastTs = Math.max(lastTs, ts);

    if (type === "session_meta") {
      session.sessionId = p.id ?? p.session_id ?? fileId;
      session.cwd = p.cwd;
      session.agentVersion = p.cli_version;
      session.entrypoint = p.originator;
      session.gitBranch = p.git?.branch;
      if (p.forked_from_id) session.parentSessionId = p.forked_from_id;
      if (p.model_provider) provider = p.model_provider;
      continue;
    }
    if (type === "turn_context") {
      if (p.model) model = p.model;
      continue;
    }
    if (type === "event_msg" && p.type === "token_count") {
      const total = p.info?.total_token_usage ? codexUsage(p.info.total_token_usage) : undefined;
      if (!total || sameUsage(total, prevTotal)) continue;
      if (!own) {
        baseline = total;
        prevTotal = total;
        continue;
      }
      // Forked threads start with the parent's cumulative total, so the first event uses the
      // per-response `last_token_usage` rather than a delta from zero.
      const last = p.info?.last_token_usage ? codexUsage(p.info.last_token_usage) : undefined;
      const delta = prevTotal ? usageDelta(total, prevTotal) : (last ?? total);
      const uncovered = recordsSinceCount ? usageDelta(delta, recordsSinceCount) : delta;
      recordsSinceCount = undefined;
      if (uncovered.input < 0 || uncovered.output < 0) {
        diag.notes.push(`token_count delta smaller than recorded usage at ${rec.timestamp}`);
      } else if (uncovered.input > 0 || uncovered.output > 0) {
        attribute(uncovered, ts);
      }
      sinceCount = [];
      // Whatever the first own total holds beyond our own calls so far was inherited.
      baseline ??= usageDelta(
        total,
        sumCalls(allCalls) ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      );
      prevTotal = total;
      continue;
    }
    if (type === "event_msg" && p.type === "task_started") {
      own = true;
      closeOpen();
      turn = {
        id: p.turn_id ?? `turn:${ts}`,
        index: session.turns.length,
        start: ts,
        end: ts,
        complete: false,
        trigger: "user",
        apiErrors: 0,
        calls: [],
        tools: [],
        compactions: [],
      };
      session.turns.push(turn);
      lastInputTs = ts;
      continue;
    }
    if (!own) {
      diag.inheritedLines++;
      continue;
    }
    if (type === "token_usage_record") {
      const usage = codexUsage(p.usage);
      recordsSinceCount = addUsage(recordsSinceCount, usage);
      // Records follow their response's output; if an input already closed it, it is the latest closed call.
      const last = sinceCount.at(-1);
      const target = open && !open.usage ? open : last && !last.usage ? sinceCount.pop() : undefined;
      if (target) {
        target.usage = usage;
        if (p.response_id) target.id = p.response_id;
        target.end = Math.max(target.end, ts);
        if (target === open) open = undefined;
      } else {
        hiddenCall(usage, ts, p.response_id);
      }
      continue;
    }
    if (type === "event_msg") {
      if (p.type === "task_complete" || p.type === "turn_aborted") {
        closeOpen();
        if (turn) {
          turn.complete = true;
          turn.end = Math.max(turn.end, ts);
        }
      } else if (p.type === "user_message" && turn && turn.prompt === undefined) {
        turn.prompt = String(p.message ?? "");
      } else if (p.type === "stream_error" || p.type === "error") {
        if (turn) turn.apiErrors++;
      }
      continue;
    }
    if (type === "compacted") {
      const c: Compaction = {
        id: hashHex(16, fileId, "compact", String(rec.timestamp)),
        start: ts,
        end: ts,
        trigger: "auto",
        summaryBytes: byteLength(p.message),
      };
      compactions.push(c);
      ensureTurn(ts).compactions.push(c);
      compactionPending = true;
      continue;
    }
    if (type !== "response_item") {
      countKey(diag.unknownRecords, `type:${type}`);
      continue;
    }

    const item = p;
    const t = ensureTurn(ts);
    if (item.type === "agent_message") {
      // Task handed to this (sub)agent thread by another agent: it is this thread's prompt.
      closeOpen();
      lastInputTs = ts;
      const text = messageText(Array.isArray(item.content) ? item.content : String(item.content ?? ""));
      if (t.prompt === undefined) {
        t.prompt = text;
        t.trigger = `agent:${item.author ?? "?"}`;
      }
      pendingInput.push({
        id: item.id ?? hashHex(16, fileId, "agent_message", String(rec.timestamp)),
        role: "user",
        parts: [{ type: "text", content: text }],
      });
      continue;
    }
    if (item.type === "message" && item.role !== "assistant") {
      closeOpen();
      lastInputTs = ts;
      if (item.role !== "user") continue;
      const text = messageText(item.content);
      // Injected context (environment, AGENTS.md, instructions) arrives as user messages wrapped in tags.
      if (text.trimStart().startsWith("<")) continue;
      t.prompt ??= text;
      pendingInput.push({
        id: item.id ?? hashHex(16, fileId, "user", String(rec.timestamp)),
        role: "user",
        parts: [{ type: "text", content: text }],
      });
      continue;
    }
    if (TOOL_OUTPUT_ITEMS.has(item.type)) {
      closeOpen();
      lastInputTs = ts;
      const out = toolOutput(item.output);
      pendingInput.push({
        id: `${item.call_id}:out`,
        role: "tool",
        parts: [{ type: "tool_call_response", id: item.call_id, result: out.text }],
      });
      const tool = tools.get(item.call_id);
      if (tool && !tool.complete) {
        tool.end = ts;
        tool.result = out.text;
        tool.resultBytes = byteLength(out.text);
        tool.isError = out.error || undefined;
        tool.complete = true;
      }
      continue;
    }
    if (item.type === "message" || OUTPUT_ITEMS.has(item.type)) {
      if (!open) {
        const since = lastInputTs || ts;
        open = {
          id: hashHex(24, fileId, t.id, String(t.calls.length)),
          start: ts - since > MAX_WAIT_MS ? ts : Math.min(since, ts),
          end: ts,
          model,
          provider,
          input: pendingInput,
          output: [{ id: "", role: "assistant", parts: [] }],
          complete: false,
          afterCompaction: compactionPending || undefined,
        };
        compactionPending = false;
        pendingInput = [];
        t.calls.push(open);
        allCalls.push(open);
      }
      open.end = Math.max(open.end, ts);
      const parts = open.output[0]!.parts;
      if (item.type === "message") {
        parts.push({ type: "text", content: messageText(item.content) });
      } else if (item.type === "reasoning") {
        // Encrypted-only reasoning has no readable text; its tokens are still in usage.
        const summary = (item.summary ?? []).map((s: any) => s?.text ?? "").join("\n");
        if (summary.trim()) parts.push({ type: "reasoning", content: summary });
      } else {
        const callId: string = item.call_id ?? item.id ?? hashHex(16, fileId, "tool", String(rec.timestamp));
        const name: string = item.namespace ? `${item.namespace}__${item.name}` : (item.name ?? item.type);
        const args = parseArgs(item.arguments ?? item.input ?? item.action);
        parts.push({ type: "tool_call", id: callId, name, arguments: args });
        if (!tools.has(callId)) {
          const serverSide = item.type === "web_search_call";
          const tool: ToolCall = {
            id: callId,
            name,
            start: ts,
            arguments: args,
            argsBytes: byteLength(args),
            callId: open.id,
            complete: serverSide,
            serverSide: serverSide || undefined,
          };
          if (tool.complete) tool.end = ts;
          tools.set(callId, tool);
          t.tools.push(tool);
        }
      }
    }
  }
  closeOpen();

  const idle = now - file.mtimeMs >= idleMs;
  session.turns.forEach((t, i) => {
    const last = i === session.turns.length - 1;
    t.complete = t.complete || !last || opts.final === true || idle;
    for (const c of t.calls) {
      if (c.output[0]) c.output[0].id = c.id;
      t.end = Math.max(t.end, c.end);
      // In token_count-only rollouts usage can arrive after the outputs; wait for it unless the turn is over.
      c.complete = t.complete || c.usage !== undefined;
    }
    for (const tool of t.tools) {
      tool.callId =
        t.calls.find((c) => c.output[0]?.parts.some((p) => p.type === "tool_call" && p.id === tool.id))?.id ??
        tool.callId;
      t.end = Math.max(t.end, tool.end ?? tool.start);
      if (!tool.complete && t.complete && !tool.serverSide) {
        tool.complete = true;
        tool.end = t.end;
        tool.isError = true;
      }
    }
  });
  analyzeThread(allCalls, compactions);

  if (prevTotal) {
    const zero: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
    session.reference = { cumulative: usageDelta(prevTotal, baseline ?? zero) };
  }
  return session;
}

export function codexHome(): string {
  return process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex");
}

export function listCodexSessions(sinceMs = 0): string[] {
  const out: { path: string; mtime: number }[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else if (/^rollout-.*\.jsonl(\.zst)?$/.test(name) && st.mtimeMs >= sinceMs) out.push({ path, mtime: st.mtimeMs });
    }
  };
  walk(join(codexHome(), "sessions"));
  walk(join(codexHome(), "archived_sessions"));
  return out.toSorted((a, b) => b.mtime - a.mtime).map((e) => e.path);
}
