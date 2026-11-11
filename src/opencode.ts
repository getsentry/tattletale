// OpenCode keeps every session in one SQLite database (~/.local/share/opencode/opencode.db): a `session` row per
// session, subagents as child sessions, and a JSON `data` blob per message and per part. Each session tree is
// written out as a snapshot shaped like `opencode export <id>` (with the child sessions under `children`) to
// ~/.tattletale/opencode/<id>.json, stamped with the session's last update, so everything downstream treats it
// like any other transcript file. `opencode export` output can be replayed directly.
//
// Facts this relies on (checked against OpenCode 1.19 runs and OpenRouter's own billing records):
// - Each `step-finish` part closes one model request and carries its usage. `tokens.input` excludes cache
//   reads and writes, and `tokens.output` excludes `tokens.reasoning`.
// - Assistant messages name their user prompt in `parentID`. A `task` tool part names the child session it
//   started in `state.metadata.sessionId`.
// - Requests OpenCode makes for itself (title generation on its small model) are not recorded anywhere.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { analyzeThread } from "./analyze.ts";
import type { Message, ModelCall, ParseOptions, Part, Run, Session, ToolCall, Turn, Usage } from "./model.ts";
import { addUsage, emptyDiagnostics } from "./model.ts";
import { home } from "./state.ts";
import { asString, byteLength, num } from "./util.ts";

const DEFAULT_IDLE_MS = 30 * 60 * 1000;

interface Snapshot {
  info: any;
  messages: { info: any; parts: any[] }[];
  children?: Snapshot[];
}

export function opencodeDb(): string {
  const data = process.env.XDG_DATA_HOME || join(process.env.HOME ?? homedir(), ".local", "share");
  return join(data, "opencode", "opencode.db");
}

function openDb(): DatabaseSync | undefined {
  const path = opencodeDb();
  if (!existsSync(path)) return undefined;
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  return new DatabaseSync(path, { readOnly: true });
}

const snapshotDir = () => join(home(), "opencode");
export const snapshotPath = (sessionId: string) => join(snapshotDir(), `${sessionId}.json`);

function rootOf(db: DatabaseSync, sessionId: string): string | undefined {
  const parent = db.prepare("SELECT parent_id FROM session WHERE id = ?");
  let id = sessionId;
  for (let depth = 0; depth < 32; depth++) {
    const row = parent.get(id) as { parent_id: string | null } | undefined;
    if (!row) return depth ? id : undefined;
    if (!row.parent_id) return id;
    id = row.parent_id;
  }
  return id;
}

/** Image and file attachments are inline data URLs; only their type is ever sent. */
function slimPart(part: any): any {
  if (part?.type === "file" && typeof part.url === "string" && part.url.startsWith("data:"))
    return { ...part, url: `data:${part.mime ?? ""};[${part.url.length} chars]` };
  return part;
}

function readTree(db: DatabaseSync, id: string): Snapshot | undefined {
  const row = db.prepare("SELECT * FROM session WHERE id = ?").get(id) as any;
  if (!row) return undefined;
  const messages: Snapshot["messages"] = [];
  const byId = new Map<string, { info: any; parts: any[] }>();
  for (const m of db
    .prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY id")
    .iterate(id) as Iterable<any>) {
    const info = { ...JSON.parse(m.data), id: m.id, sessionID: id };
    // User messages carry the turn's full diff; nothing downstream reads it.
    if (info.summary && typeof info.summary === "object") delete info.summary.diffs;
    const entry = { info, parts: [] as any[] };
    messages.push(entry);
    byId.set(m.id, entry);
  }
  for (const p of db
    .prepare("SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY id")
    .iterate(id) as Iterable<any>) {
    byId.get(p.message_id)?.parts.push(slimPart({ ...JSON.parse(p.data), id: p.id, messageID: p.message_id }));
  }
  const children: Snapshot[] = [];
  for (const c of db.prepare("SELECT id FROM session WHERE parent_id = ? ORDER BY id").all(id) as any[]) {
    const child = readTree(db, c.id);
    if (child) children.push(child);
  }
  const info = {
    id: row.id,
    parentID: row.parent_id ?? undefined,
    directory: row.directory,
    title: row.title,
    version: row.version,
    agent: row.agent ?? undefined,
    tokens:
      row.tokens_input === undefined
        ? undefined
        : {
            input: num(row.tokens_input),
            output: num(row.tokens_output),
            reasoning: num(row.tokens_reasoning),
            cache: { read: num(row.tokens_cache_read), write: num(row.tokens_cache_write) },
          },
    cost: row.cost ?? undefined,
    time: { created: num(row.time_created), updated: num(row.time_updated) },
  };
  return { info, messages, ...(children.length && { children }) };
}

const TREE_UPDATED = `
  WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT s.id FROM session s JOIN tree t ON s.parent_id = t.id)
  SELECT max(u) AS u FROM (
    SELECT max(time_updated) AS u FROM session WHERE id IN tree
    UNION ALL SELECT max(time_updated) FROM message WHERE session_id IN tree
    UNION ALL SELECT max(time_updated) FROM part WHERE session_id IN tree)`;

/** Writes (or refreshes) the snapshot of the session tree containing `sessionId`. */
function writeSnapshot(db: DatabaseSync, sessionId: string): string | undefined {
  const root = rootOf(db, sessionId);
  if (!root) return undefined;
  const path = snapshotPath(root);
  // The file's mtime is the session's last activity: sweeps, idle detection and replay windows go by it.
  const updated = num((db.prepare(TREE_UPDATED).get(root) as any)?.u);
  if (existsSync(path) && Math.abs(statSync(path).mtimeMs - updated) < 1) return path;
  const tree = readTree(db, root);
  if (!tree) return undefined;
  mkdirSync(snapshotDir(), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(tree));
  renameSync(tmp, path);
  const at = new Date(updated);
  utimesSync(path, at, at);
  return path;
}

/** The snapshot for a session (or one of its subagents), refreshed from OpenCode's database. */
export function opencodeSnapshot(sessionId: string): string | undefined {
  const db = openDb();
  if (!db) return undefined;
  try {
    return writeSnapshot(db, sessionId);
  } finally {
    db.close();
  }
}

/** Snapshots of session trees active since `sinceMs`, newest first. */
export function listOpencodeSessions(sinceMs = 0): string[] {
  const db = openDb();
  if (!db) return [];
  try {
    const roots = new Set<string>();
    for (const r of db
      .prepare("SELECT id FROM session WHERE time_updated >= ? ORDER BY time_updated DESC")
      .all(sinceMs) as any[]) {
      const root = rootOf(db, r.id);
      if (root) roots.add(root);
    }
    const out: { path: string; mtime: number }[] = [];
    for (const id of roots) {
      const path = writeSnapshot(db, id);
      if (path) out.push({ path, mtime: statSync(path).mtimeMs });
    }
    return out.toSorted((a, b) => b.mtime - a.mtime).map((e) => e.path);
  } finally {
    db.close();
  }
}

// ---- parsing ----

/** OpenCode's counts in Sentry's convention: input includes cache, output includes reasoning. */
export function opencodeUsage(t: any): Usage {
  const read = num(t?.cache?.read);
  const write = num(t?.cache?.write);
  const reasoning = num(t?.reasoning);
  return {
    input: num(t?.input) + read + write,
    cacheRead: read,
    cacheWrite: write,
    output: num(t?.output) + reasoning,
    reasoning,
  };
}

function toolResult(state: any): unknown {
  return state?.status === "error" ? (state.error ?? "error") : state?.output;
}

interface Thread extends Run {
  pending: Message[];
  last?: ModelCall;
}

const newThread = (): Thread => ({ calls: [], tools: [], compactions: [], pending: [] });

const content = (p: any) => p.type === "text" || p.type === "reasoning" || p.type === "tool";

/** One assistant message: one model call per step (OpenCode 1.19 writes one step per message). */
function feedAssistant(
  th: Thread,
  msg: { info: any; parts: any[] },
  session: Session,
  children: Map<string, Snapshot>,
  subagentParents: Map<string, string>,
): void {
  const info = msg.info;
  const created = num(info.time?.created);
  const completed = num(info.time?.completed) || undefined;
  if (info.error && !msg.parts.some((p) => p.type === "step-finish")) {
    session.diagnostics.notes.push(
      `api error in ${info.id}: ${asString(info.error?.name ?? info.error).slice(0, 120)}`,
    );
    return;
  }
  const isSummary = info.summary === true || info.mode === "compaction" || info.agent === "compaction";
  let step: any[] = [];
  let stepStart = created;
  const steps: { parts: any[]; finish?: any; start: number }[] = [];
  for (const p of msg.parts) {
    if (p.type === "step-start") {
      if (step.length) steps.push({ parts: step, start: stepStart });
      step = [];
      continue;
    }
    if (p.type === "step-finish") {
      steps.push({ parts: step, finish: p, start: stepStart });
      stepStart = Math.max(stepStart, ...step.map((x) => num(x.state?.time?.end ?? x.time?.end)));
      step = [];
      continue;
    }
    step.push(p);
  }
  // Parts after the last step-finish (a `patch` record) belong to no request; a step without its step-finish is a
  // request still streaming. Only a message with no step records at all takes its usage from the message itself.
  const stepped = msg.parts.some((p) => p.type === "step-start" || p.type === "step-finish");
  const legacyDone = !stepped && info.tokens && completed;
  if (!steps.length || step.some(content))
    steps.push({
      parts: step,
      start: stepStart,
      finish: legacyDone ? { tokens: info.tokens, reason: info.finish, id: info.id } : undefined,
    });

  steps.forEach((s, i) => {
    const lastStep = i === steps.length - 1;
    const id = s.finish?.id ?? (steps.length > 1 ? `${info.id}:${i}` : info.id);
    const partEnd = Math.max(0, ...s.parts.map((x) => num(x.time?.end ?? x.state?.time?.start)));
    const end = (lastStep ? completed : undefined) ?? (partEnd || completed || s.start);
    const parts: Part[] = [];
    const tools: ToolCall[] = [];
    for (const p of s.parts) {
      if (p.type === "text" && p.text && !p.synthetic) parts.push({ type: "text", content: p.text });
      else if (p.type === "reasoning" && p.text) parts.push({ type: "reasoning", content: p.text });
      else if (p.type === "tool") {
        const state = p.state ?? {};
        parts.push({ type: "tool_call", id: p.callID, name: p.tool, arguments: state.input });
        const done = state.status === "completed" || state.status === "error";
        const result = done ? toolResult(state) : undefined;
        const tool: ToolCall = {
          id: p.callID,
          name: p.tool,
          start: num(state.time?.start) || end,
          end: done ? num(state.time?.end) || end : undefined,
          arguments: state.input,
          result,
          argsBytes: byteLength(state.input),
          resultBytes: done ? byteLength(result) : undefined,
          // A shell command that exits non-zero is "completed" to OpenCode; Claude's transcripts call it an error.
          isError: state.status === "error" || (num(state.metadata?.exit) !== 0 && done) || undefined,
          callId: id,
          complete: done,
        };
        tools.push(tool);
        const child = state.metadata?.sessionId;
        if (p.tool === "task" && typeof child === "string" && children.has(child)) subagentParents.set(child, p.callID);
      }
    }
    const call: ModelCall = {
      id,
      start: s.start,
      end: Math.max(end, s.start),
      model: info.modelID ?? "unknown",
      provider: info.providerID ?? "unknown",
      usage: s.finish?.tokens ? opencodeUsage(s.finish.tokens) : undefined,
      input: th.pending,
      output: parts.length ? [{ id, role: "assistant", parts }] : [],
      finishReason: s.finish?.reason ?? info.finish,
      complete: s.finish !== undefined,
      afterCompaction: (th.last && th.compactions.some((c) => c.end <= s.start && c.end > th.last!.end)) || undefined,
    };
    th.calls.push(call);
    th.tools.push(...tools);
    th.last = call;
    const results = tools
      .filter((t) => t.complete)
      .map((t): Part => ({ type: "tool_call_response", id: t.id, result: t.result }));
    th.pending = results.length ? [{ id: `${id}:results`, role: "tool", parts: results }] : [];
    if (isSummary && lastStep) th.compactions.push({ id: info.id, start: created, end: call.end, trigger: "summary" });
  });
}

function promptOf(msg: { info: any; parts: any[] }): Message {
  const parts: Part[] = [];
  for (const p of msg.parts) {
    if (p.type === "text" && p.text && !p.synthetic) parts.push({ type: "text", content: p.text });
    else if (p.type === "file") parts.push({ type: "blob", mime_type: p.mime ?? "application/octet-stream" });
  }
  return { id: msg.info.id, role: "user", parts };
}

/**
 * Once a thread is done, a request that never got its step-finish was cut off: OpenCode recorded no usage for it.
 * It is dropped rather than sent, because a span sent without usage could not be corrected later.
 */
function dropUnfinished(run: Run, done: boolean, session: Session): void {
  if (!done) return;
  const cut = run.calls.filter((c) => !c.complete);
  if (!cut.length) return;
  run.calls = run.calls.filter((c) => c.complete);
  session.diagnostics.notes.push(`${cut.length} request(s) ended without usage: ${cut.map((c) => c.id).join(", ")}`);
}

function finishTools(run: Run, done: boolean, end: number): void {
  for (const tool of run.tools) {
    if (!tool.complete && done) {
      tool.complete = true;
      tool.end = end;
      tool.isError = true;
    }
  }
}

export function parseOpencode(path: string, opts: ParseOptions = {}): Session {
  const now = opts.now ?? Date.now();
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const snap = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
  const info = snap.info ?? {};
  const session: Session = {
    agent: "opencode",
    sessionId: info.id,
    path,
    cwd: info.directory,
    agentVersion: info.version,
    parentSessionId: info.parentID,
    turns: [],
    subagents: [],
    diagnostics: emptyDiagnostics(),
  };
  const idle = now - statSync(path).mtimeMs >= idleMs;

  const children = new Map<string, Snapshot>();
  const collect = (s: Snapshot) => {
    for (const c of s.children ?? []) {
      children.set(c.info?.id, c);
      collect(c);
    }
  };
  collect(snap);
  const subagentParents = new Map<string, string>();

  const main = newThread();
  let turn: Turn | undefined;
  const turnOf = new Map<string, Turn>();
  for (const msg of snap.messages ?? []) {
    const m = msg.info ?? {};
    if (m.role === "user") {
      const prompt = promptOf(msg);
      const compaction = msg.parts.some((p) => p.type === "compaction");
      turn = {
        id: m.id,
        index: session.turns.length,
        start: num(m.time?.created),
        end: num(m.time?.created),
        complete: false,
        prompt: prompt.parts.map((p) => (p.type === "text" ? p.content : "")).join("\n") || undefined,
        trigger: compaction ? "compaction" : "user",
        apiErrors: 0,
        calls: [],
        tools: [],
        compactions: [],
      };
      session.turns.push(turn);
      turnOf.set(m.id, turn);
      main.pending = prompt.parts.length ? [prompt] : [];
      continue;
    }
    if (m.role !== "assistant") continue;
    const t = turnOf.get(m.parentID) ?? turn;
    if (!t) continue;
    const before = { calls: main.calls.length, tools: main.tools.length, compactions: main.compactions.length };
    feedAssistant(main, msg, session, children, subagentParents);
    if (m.error && main.calls.length === before.calls) t.apiErrors++;
    t.calls.push(...main.calls.slice(before.calls));
    t.tools.push(...main.tools.slice(before.tools));
    t.compactions.push(...main.compactions.slice(before.compactions));
  }

  session.turns.forEach((t, i) => {
    const last = i === session.turns.length - 1;
    const lastCall = t.calls.at(-1);
    const stopped =
      lastCall?.complete === true && lastCall.finishReason !== undefined && lastCall.finishReason !== "tool-calls";
    t.complete = !last || opts.final === true || idle || stopped;
    dropUnfinished(t, t.complete, session);
    for (const c of t.calls) t.end = Math.max(t.end, c.end);
    for (const tool of t.tools) t.end = Math.max(t.end, tool.end ?? tool.start);
    finishTools(t, t.complete, t.end);
  });
  analyzeThread(
    session.turns.flatMap((t) => t.calls),
    main.compactions,
  );

  // Subagents: each child session is one run. Parents before children, so nesting resolves.
  for (const [childId, child] of children) {
    const th = newThread();
    let start = num(child.info?.time?.created);
    for (const msg of child.messages ?? []) {
      const m = msg.info ?? {};
      if (m.role === "user") {
        const prompt = promptOf(msg);
        th.pending = prompt.parts.length ? [prompt] : [];
        start ||= num(m.time?.created);
      } else if (m.role === "assistant") feedAssistant(th, msg, session, children, subagentParents);
    }
    const end = Math.max(start, ...th.calls.map((c) => c.end), ...th.tools.map((t) => t.end ?? t.start));
    const parentToolId = subagentParents.get(childId);
    const parentTool = [...session.turns.flatMap((t) => t.tools), ...session.subagents.flatMap((r) => r.tools)].find(
      (t) => t.id === parentToolId,
    );
    const lastCall = th.calls.at(-1);
    const complete =
      opts.final === true ||
      idle ||
      parentTool?.complete === true ||
      (lastCall?.complete === true && lastCall.finishReason !== "tool-calls");
    dropUnfinished(th, complete, session);
    finishTools(th, complete, end);
    analyzeThread(th.calls, th.compactions);
    const args = (parentTool?.arguments ?? {}) as any;
    session.subagents.push({
      agentId: childId,
      agentType: args.subagent_type ?? child.info?.agent ?? "subagent",
      description: args.description ?? child.info?.title,
      start,
      end,
      complete,
      parentToolId,
      calls: th.calls,
      tools: th.tools,
      compactions: th.compactions,
    });
  }

  // OpenCode's own per-session totals (each session excludes its children), for `verify`.
  let totals: Usage | undefined;
  for (const s of [snap, ...children.values()])
    if (s.info?.tokens) totals = addUsage(totals, opencodeUsage(s.info.tokens));
  if (totals) session.reference = { ...session.reference, opencodeTotals: totals };
  return session;
}

/** Every step-finish in a snapshot, read naively: what `verify` compares the parser against. */
export function naiveOpencode(path: string): { usage?: Usage; ids: string[] } {
  const snap = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
  let usage: Usage | undefined;
  const ids: string[] = [];
  const walk = (s: Snapshot) => {
    for (const m of s.messages ?? [])
      for (const p of m.parts ?? [])
        if (p.type === "step-finish") {
          usage = addUsage(usage, opencodeUsage(p.tokens));
          ids.push(p.id);
        }
    for (const c of s.children ?? []) walk(c);
  };
  walk(snap);
  return { usage, ids };
}

export const isOpencodeSnapshot = (path: string): boolean => /(^|\/)ses_[A-Za-z0-9]+\.json$/.test(path);
