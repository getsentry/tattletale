// Claude Code transcripts: ~/.claude/projects/<cwd-slug>/<session>.jsonl, subagents in <session>/subagents/.
//
// Facts this relies on (checked against real transcripts):
// - One API response is written as several `assistant` lines (one per content block) sharing
//   `message.id`, each carrying the same `usage`. Count usage once per `message.id`.
// - Resumed/forked sessions copy the parent's history into the new file as a prefix, keeping the
//   parent's `sessionId` on each copied line. Those lines are skipped here and only counted via the
//   session that owns them, so nothing is sent twice.
// - Anthropic's `input_tokens` excludes cache reads and writes; Sentry's includes them.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { analyzeThread } from "./analyze.ts";
import type {
  Compaction,
  Message,
  ModelCall,
  ParseOptions,
  Part,
  Run,
  Session,
  SubagentRun,
  ToolCall,
  Turn,
  Usage,
} from "./model.ts";
import { emptyDiagnostics } from "./model.ts";
import { byteLength, countKey, jsonlRecords, num, toMs } from "./util.ts";

function firstTimestamp(path: string): number {
  for (const rec of jsonlRecords(path)) if (rec?.timestamp) return toMs(rec.timestamp) ?? 0;
  return 0;
}

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
/** A request can't plausibly wait this long between its last input and its first output line. */
const MAX_WAIT_MS = 15 * 60 * 1000;
const TURN_END_MARKERS = new Set(["stop_hook_summary", "turn_duration"]);

export function claudeUsage(u: any): Usage {
  const fresh = num(u?.input_tokens);
  const read = num(u?.cache_read_input_tokens);
  const write = num(u?.cache_creation_input_tokens);
  const extra: Record<string, number> = {};
  const cc = u?.cache_creation;
  if (cc) {
    extra.cache_write_5m = num(cc.ephemeral_5m_input_tokens);
    extra.cache_write_1h = num(cc.ephemeral_1h_input_tokens);
  }
  const searches = num(u?.server_tool_use?.web_search_requests);
  if (searches) extra.web_search_requests = searches;
  // Top-level usage equals the single iteration in every transcript seen so far; flag anything else.
  if (Array.isArray(u?.iterations) && u.iterations.length > 1) extra.iterations = u.iterations.length;
  const thinking = u?.output_tokens_details?.thinking_tokens;
  return {
    input: fresh + read + write,
    cacheRead: read,
    cacheWrite: write,
    output: num(u?.output_tokens),
    reasoning: typeof thinking === "number" ? thinking : undefined,
    extra,
  };
}

interface Thread {
  current: () => Run;
  pendingInput: Message[];
  lastActivity: number;
  open?: ModelCall;
  /** True once any record follows the open call's last line. */
  openFollowed: boolean;
  byId: Map<string, ModelCall>;
  tools: Map<string, ToolCall>;
  asyncTools: Set<string>;
  agentIdByTool: Map<string, string>;
  calls: ModelCall[];
  compactions: Compaction[];
  lastCompaction?: Compaction;
  /** Message IDs owned by files parsed earlier in this session (fork subagents copy their parent's history). */
  claimed: Set<string>;
  inheritedTools: Set<string>;
  compactionPending: boolean;
}

function newThread(current: () => Run, claimed: Set<string> = new Set()): Thread {
  return {
    current,
    claimed,
    inheritedTools: new Set(),
    compactionPending: false,
    pendingInput: [],
    lastActivity: 0,
    openFollowed: false,
    byId: new Map(),
    tools: new Map(),
    asyncTools: new Set(),
    agentIdByTool: new Map(),
    calls: [],
    compactions: [],
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: any) => (b?.type === "text" ? (b.text ?? "") : b?.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

function promptParts(content: unknown): Part[] {
  if (typeof content === "string") return [{ type: "text", content }];
  if (!Array.isArray(content)) return [];
  const parts: Part[] = [];
  for (const b of content as any[]) {
    if (b?.type === "text") parts.push({ type: "text", content: b.text ?? "" });
    else if (b?.type === "image") parts.push({ type: "blob", mime_type: b.source?.media_type ?? "image" });
  }
  return parts;
}

function triggerOf(text: string): string {
  if (text.startsWith("<task-notification")) return "notification";
  if (text.startsWith("<command-name>") || text.startsWith("<command-message>")) return "command";
  return "user";
}

function handleAssistant(th: Thread, rec: any, ts: number, session: Session): void {
  const msg = rec.message ?? {};
  if (msg.model === "<synthetic>") {
    session.diagnostics.syntheticMessages++;
    th.lastActivity = ts;
    return;
  }
  const id: string = msg.id ?? rec.uuid;
  let call = th.byId.get(id);
  if (!call && th.claimed.has(id)) {
    // Copied history (fork subagent): owned and counted by the file it came from.
    session.diagnostics.inheritedLines++;
    for (const b of Array.isArray(msg.content) ? msg.content : [])
      if (b?.type === "tool_use" || b?.type === "server_tool_use") th.inheritedTools.add(b.id);
    th.pendingInput = [];
    th.lastActivity = ts;
    return;
  }
  if (!call) {
    const since = th.lastActivity || ts;
    call = {
      id,
      start: ts - since > MAX_WAIT_MS ? ts : Math.min(since, ts),
      end: ts,
      model: msg.model ?? "unknown",
      provider: "anthropic",
      input: th.pendingInput,
      output: [{ id, role: "assistant", parts: [] }],
      complete: false,
      afterCompaction: th.compactionPending || undefined,
    };
    th.compactionPending = false;
    th.pendingInput = [];
    th.byId.set(id, call);
    th.calls.push(call);
    th.current().calls.push(call);
  }
  th.open = call;
  th.openFollowed = false;
  call.end = Math.max(call.end, ts);
  if (msg.usage) call.usage = claudeUsage(msg.usage);
  if (msg.stop_reason) call.finishReason = msg.stop_reason;
  const parts = call.output[0]!.parts;
  for (const block of Array.isArray(msg.content) ? msg.content : []) {
    switch (block?.type) {
      case "text":
        parts.push({ type: "text", content: block.text ?? "" });
        break;
      // Claude Code stores thinking without its text (signature only); empty parts would just be noise.
      case "thinking":
        if (block.thinking?.trim()) parts.push({ type: "reasoning", content: block.thinking });
        break;
      case "redacted_thinking":
        break;
      case "tool_use":
      case "server_tool_use": {
        parts.push({ type: "tool_call", id: block.id, name: block.name, arguments: block.input });
        if (!th.tools.has(block.id)) {
          const serverSide = block.type === "server_tool_use";
          const tool: ToolCall = {
            id: block.id,
            name: block.name,
            start: ts,
            end: serverSide ? ts : undefined,
            arguments: block.input,
            argsBytes: byteLength(block.input),
            callId: id,
            complete: serverSide,
            serverSide: serverSide || undefined,
          };
          th.tools.set(block.id, tool);
          th.current().tools.push(tool);
        }
        break;
      }
      case "web_search_tool_result":
        break;
      default:
        countKey(session.diagnostics.unknownRecords, `assistant-block:${block?.type}`);
    }
  }
  th.lastActivity = ts;
}

/** Returns the prompt message if this record is a real user prompt, after handling tool results/meta. */
function handleUser(th: Thread, rec: any, ts: number): Message | undefined {
  const content = rec.message?.content;
  th.lastActivity = ts;
  if (Array.isArray(content) && content.some((b: any) => b?.type === "tool_result")) {
    const msg: Message = { id: rec.uuid, role: "tool", parts: [] };
    for (const b of content) {
      if (b?.type !== "tool_result" || th.inheritedTools.has(b.tool_use_id)) continue;
      const result = textOf(b.content);
      msg.parts.push({ type: "tool_call_response", id: b.tool_use_id, result });
      const tool = th.tools.get(b.tool_use_id);
      if (tool && !tool.complete) {
        tool.end = ts;
        tool.result = result;
        tool.resultBytes = byteLength(result);
        tool.isError = b.is_error === true || undefined;
        tool.complete = true;
      }
      const tur = rec.toolUseResult;
      if (tur && typeof tur === "object") {
        if (tur.isAsync === true) th.asyncTools.add(b.tool_use_id);
        if (typeof tur.agentId === "string") th.agentIdByTool.set(b.tool_use_id, tur.agentId);
      }
    }
    if (msg.parts.length) th.pendingInput.push(msg);
    return undefined;
  }
  if (rec.isMeta) return undefined;
  if (rec.isCompactSummary) {
    if (th.lastCompaction) th.lastCompaction.summaryBytes = byteLength(textOf(content));
    return undefined;
  }
  const prompt: Message = { id: rec.uuid, role: "user", parts: promptParts(content) };
  th.pendingInput.push(prompt);
  return prompt;
}

function handleSystem(th: Thread, rec: any, ts: number): string | undefined {
  if (rec.subtype === "compact_boundary") {
    const meta = rec.compactMetadata ?? {};
    const compaction: Compaction = {
      id: rec.uuid,
      start: ts - num(meta.durationMs),
      end: ts,
      trigger: meta.trigger,
      preTokens: meta.preTokens,
      postTokens: meta.postTokens,
    };
    th.compactions.push(compaction);
    th.current().compactions.push(compaction);
    th.lastCompaction = compaction;
    th.compactionPending = true;
  }
  return rec.subtype;
}

/** Feed one record into a thread. Returns the kind of record handled, for the caller's bookkeeping. */
function feed(th: Thread, rec: any, ts: number, session: Session): { prompt?: Message; system?: string } {
  if (th.open && !(rec.type === "assistant" && (rec.message?.id ?? rec.uuid) === th.open.id)) th.openFollowed = true;
  if (rec.type === "assistant") {
    handleAssistant(th, rec, ts, session);
    return {};
  }
  if (rec.type === "user") return { prompt: handleUser(th, rec, ts) };
  if (rec.type === "system") return { system: handleSystem(th, rec, ts) };
  return {};
}

function finishRun(run: Run, end: number, complete: boolean, th: Thread): void {
  for (const call of run.calls) call.complete = complete || call !== th.open || th.openFollowed;
  for (const tool of run.tools) {
    if (tool.complete) continue;
    if (complete) {
      tool.complete = true;
      tool.end = Math.max(tool.start, end);
      tool.isError = true;
    }
  }
}

function runEnd(run: Run, floor: number): number {
  let end = floor;
  for (const c of run.calls) end = Math.max(end, c.end);
  for (const t of run.tools) end = Math.max(end, t.end ?? t.start);
  for (const c of run.compactions) end = Math.max(end, c.end);
  return end;
}

export function parseClaude(path: string, opts: ParseOptions = {}): Session {
  const now = opts.now ?? Date.now();
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const sessionId = basename(path).replace(/\.jsonl(\.zst)?$/, "");
  const session: Session = {
    agent: "claude-code",
    sessionId,
    path,
    turns: [],
    subagents: [],
    diagnostics: emptyDiagnostics(),
  };

  let turn: Turn | undefined;
  const markerTs = new Map<Turn, number>();
  const ensureTurn = (id: string, ts: number): Turn => {
    if (!turn) {
      // Records before the first own prompt continue a turn started in the parent session.
      turn = {
        id,
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
  let lastTs = 0;
  const th = newThread(() => ensureTurn(`continuation:${sessionId}`, lastTs));

  for (const rec of jsonlRecords(path, session.diagnostics)) {
    const type = rec?.type;
    if (type === "cost-state") {
      if (rec.sessionId === sessionId) captureCostState(session, rec);
      continue;
    }
    if (type !== "user" && type !== "assistant" && type !== "system") {
      countKey(session.diagnostics.unknownRecords, `type:${type}`);
      // Injected context and queued commands are activity: a model request follows them.
      const at = rec?.sessionId === sessionId ? toMs(rec.timestamp) : undefined;
      if (at && at > th.lastActivity) th.lastActivity = at;
      continue;
    }
    if (rec.sessionId && rec.sessionId !== sessionId) {
      session.diagnostics.inheritedLines++;
      session.parentSessionId = rec.sessionId;
      continue;
    }
    const ts = toMs(rec.timestamp) ?? lastTs;
    lastTs = Math.max(lastTs, ts);
    session.cwd ??= rec.cwd;
    if (rec.gitBranch) session.gitBranch = rec.gitBranch;
    if (rec.version) session.agentVersion = rec.version;
    session.entrypoint ??= rec.entrypoint;

    if (rec.isSidechain) {
      // Pre-subagents-directory versions inline subagent traffic. Count its tokens, not its messages.
      if (type === "assistant" && rec.message?.usage && rec.message?.model !== "<synthetic>") {
        const id = rec.message.id ?? rec.uuid;
        if (!th.byId.has(id)) {
          const call: ModelCall = {
            id,
            start: ts,
            end: ts,
            model: rec.message.model ?? "unknown",
            provider: "anthropic",
            input: [],
            output: [],
            complete: true,
            sidechain: true,
            usage: claudeUsage(rec.message.usage),
          };
          th.byId.set(id, call);
          ensureTurn(rec.uuid, ts).calls.push(call);
          session.diagnostics.sidechainCalls++;
        }
      }
      continue;
    }

    if (type === "user" && isPrompt(rec)) {
      const text = textOf(rec.message?.content);
      turn = {
        id: rec.uuid,
        index: session.turns.length,
        start: ts,
        end: ts,
        complete: false,
        prompt: text,
        trigger: triggerOf(text),
        apiErrors: 0,
        calls: [],
        tools: [],
        compactions: [],
      };
      session.turns.push(turn);
    }
    const handled = feed(th, rec, ts, session);
    if (handled.system === "api_error" && turn) turn.apiErrors++;
    if (handled.system && TURN_END_MARKERS.has(handled.system) && turn) markerTs.set(turn, ts);
  }

  const idle = now - statSync(path).mtimeMs >= idleMs;
  session.turns.forEach((t, i) => {
    const last = i === session.turns.length - 1;
    const marker = markerTs.get(t) ?? 0;
    const markerAfterWork = marker > 0 && marker >= runEnd(t, 0);
    t.complete = !last || markerAfterWork || opts.final === true || idle;
    t.end = runEnd(t, Math.max(t.start, marker));
    finishRun(t, t.end, t.complete, th);
  });
  analyzeThread(
    th.calls.filter((c) => !c.sidechain),
    th.compactions,
  );

  session.subagents = parseClaudeSubagents(path, sessionId, th, now, idleMs, session);
  return session;
}

function isPrompt(rec: any): boolean {
  if (rec.isMeta || rec.isCompactSummary) return false;
  const content = rec.message?.content;
  if (Array.isArray(content) && content.some((b: any) => b?.type === "tool_result")) return false;
  return typeof content === "string" || Array.isArray(content);
}

function captureCostState(session: Session, rec: any): void {
  let usage = rec.modelUsage;
  if (typeof usage === "string") {
    try {
      usage = JSON.parse(usage);
    } catch {
      return;
    }
  }
  if (!usage || typeof usage !== "object") return;
  const out: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {};
  for (const [model, u] of Object.entries<any>(usage)) {
    const read = num(u.cacheReadInputTokens);
    const write = num(u.cacheCreationInputTokens);
    out[model] = {
      input: num(u.inputTokens) + read + write,
      output: num(u.outputTokens),
      cacheRead: read,
      cacheWrite: write,
    };
  }
  session.reference = { ...session.reference, claudeCostState: out };
}

function parseClaudeSubagents(
  path: string,
  sessionId: string,
  main: Thread,
  now: number,
  idleMs: number,
  session: Session,
): SubagentRun[] {
  const dir = join(dirname(path), sessionId, "subagents");
  if (!existsSync(dir)) return [];
  const toolOfAgent = new Map<string, string>();
  for (const [tool, agent] of main.agentIdByTool) toolOfAgent.set(agent, tool);
  const runs: SubagentRun[] = [];
  const asyncTools = new Set(main.asyncTools);
  const completedTools = new Set<string>();
  for (const t of main.tools.values()) if (t.complete && t.result !== undefined) completedTools.add(t.id);

  // Parents before children, so a fork subagent's copy of its parent's history is recognised as copied.
  const files = readdirSync(dir)
    .filter((n) => n.endsWith(".jsonl"))
    .map((name) => {
      const file = join(dir, name);
      return { name, file, firstTs: firstTimestamp(file), meta: readMeta(file.replace(/\.jsonl$/, ".meta.json")) };
    })
    .toSorted(
      (a, b) =>
        num(a.meta.spawnDepth) - num(b.meta.spawnDepth) || a.firstTs - b.firstTs || a.name.localeCompare(b.name),
    );
  const claimed = new Set(main.byId.keys());

  for (const { name, file, meta } of files) {
    const agentId = name.replace(/^agent-/, "").replace(/\.jsonl$/, "");
    const run: SubagentRun = {
      agentId,
      agentType: meta.agentType ?? "subagent",
      description: meta.description,
      start: 0,
      end: 0,
      complete: false,
      parentToolId: meta.toolUseId ?? toolOfAgent.get(agentId),
      calls: [],
      tools: [],
      compactions: [],
    };
    const th = newThread(() => run, claimed);
    let lastTs = 0;
    let owned = 0;
    for (const rec of jsonlRecords(file, session.diagnostics)) {
      if (rec?.type !== "user" && rec?.type !== "assistant" && rec?.type !== "system") {
        const at = rec?.sessionId === sessionId ? toMs(rec.timestamp) : undefined;
        if (at && at > th.lastActivity) th.lastActivity = at;
        continue;
      }
      // Forking a session copies its subagents/ directory too; those lines keep the original sessionId.
      if (rec.sessionId && rec.sessionId !== sessionId) {
        session.diagnostics.inheritedLines++;
        continue;
      }
      owned++;
      const ts = toMs(rec.timestamp) ?? lastTs;
      lastTs = Math.max(lastTs, ts);
      if (!run.start) run.start = ts;
      feed(th, rec, ts, session);
    }
    for (const id of th.byId.keys()) claimed.add(id);
    if (!owned) continue;
    for (const t of th.tools.values()) if (t.complete && t.result !== undefined) completedTools.add(t.id);
    for (const t of th.asyncTools) asyncTools.add(t);
    const parentDone =
      run.parentToolId !== undefined && completedTools.has(run.parentToolId) && !asyncTools.has(run.parentToolId);
    run.complete = meta.finished === true || parentDone || now - statSync(file).mtimeMs >= idleMs;
    run.end = runEnd(run, run.start);
    finishRun(run, run.end, run.complete, th);
    analyzeThread(th.calls, th.compactions);
    runs.push(run);
  }
  return runs;
}

function readMeta(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function claudeProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? "", ".claude");
  return join(base, "projects");
}

/** Main-session transcripts, newest first. */
export function listClaudeSessions(sinceMs = 0): string[] {
  const root = claudeProjectsDir();
  if (!existsSync(root)) return [];
  const out: { path: string; mtime: number }[] = [];
  for (const project of readdirSync(root)) {
    const dir = join(root, project);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      const mtime = statSync(path).mtimeMs;
      if (mtime >= sinceMs) out.push({ path, mtime });
    }
  }
  return out.toSorted((a, b) => b.mtime - a.mtime).map((e) => e.path);
}
