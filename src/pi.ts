// Pi (pi.dev) appends each session to one JSONL file, ~/.pi/agent/sessions/--<cwd>--/<timestamp>_<id>.jsonl: a
// `session` header, then entries that form a tree through `id`/`parentId` (the user can branch with /tree).
//
// Facts this relies on (checked against Pi 1.5's session manager and real sessions):
// - Pi writes only finished messages: every assistant entry is one complete model request with its usage.
//   `message.timestamp` is when the request started; the entry's `timestamp` is when it was written.
// - `usage.input` excludes cache reads and writes; `usage.output` already includes `usage.reasoning`.
// - Other model work is recorded too: `usage` entries (cache warming), compaction and branch summaries, and tool
//   results of tools that made model calls themselves (codemode). Pi counts all of it in the session's cost.
// - /fork and /clone copy entries verbatim, IDs and timestamps included, under a new header that names the
//   parent session. Copied entries are older than the header and are left to the parent.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { analyzeThread } from "./analyze.ts";
import type { Compaction, Message, ModelCall, ParseOptions, Part, Session, ToolCall, Turn, Usage } from "./model.ts";
import { addUsage, emptyDiagnostics } from "./model.ts";
import { asString, byteLength, countKey, jsonlRecords, num } from "./util.ts";

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const FILE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[^/]+\.jsonl$/;

export const isPiSession = (path: string): boolean => FILE.test(basename(path));

export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(process.env.HOME ?? homedir(), ".pi", "agent");
}

function piSessionDir(): string {
  if (process.env.PI_CODING_AGENT_SESSION_DIR) return resolve(process.env.PI_CODING_AGENT_SESSION_DIR);
  try {
    const dir = JSON.parse(readFileSync(join(piAgentDir(), "settings.json"), "utf8"))?.sessionDir;
    if (typeof dir === "string" && dir) {
      const expanded = dir.startsWith("~/") ? join(process.env.HOME ?? homedir(), dir.slice(2)) : dir;
      // A relative sessionDir resolves against each project's directory; those sessions are found by hooks only.
      if (isAbsolute(expanded)) return expanded;
    }
  } catch {}
  return join(piAgentDir(), "sessions");
}

/** Session files modified since `sinceMs`, newest first. */
export function listPiSessions(sinceMs = 0): string[] {
  const out: { path: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) {
        if (depth < 2) walk(path, depth + 1);
      } else if (FILE.test(name) && st.mtimeMs >= sinceMs) out.push({ path, mtime: st.mtimeMs });
    }
  };
  walk(piSessionDir(), 0);
  return out.toSorted((a, b) => b.mtime - a.mtime).map((e) => e.path);
}

/** Pi's counts in Sentry's convention: input includes cache reads and writes. */
export function piUsage(u: any): Usage {
  const read = num(u?.cacheRead);
  const write = num(u?.cacheWrite);
  const write1h = num(u?.cacheWrite1h);
  return {
    input: num(u?.input) + read + write,
    cacheRead: read,
    cacheWrite: write,
    output: num(u?.output),
    reasoning: u?.reasoning === undefined ? undefined : num(u.reasoning),
    extra: write1h ? { cache_write_1h: write1h, cache_write_5m: write - write1h } : undefined,
  };
}

const hasTokens = (u: any) => u && num(u.input) + num(u.output) + num(u.cacheRead) + num(u.cacheWrite) > 0;
const ms = (iso: unknown) => (typeof iso === "string" ? Date.parse(iso) || 0 : 0);

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function contentParts(content: unknown): Part[] {
  if (typeof content === "string") return content ? [{ type: "text", content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: Part[] = [];
  for (const b of content) {
    if (b?.type === "text" && b.text) parts.push({ type: "text", content: b.text });
    else if (b?.type === "image") parts.push({ type: "blob", mime_type: b.mimeType ?? "image" });
  }
  return parts;
}

function outputParts(content: unknown): Part[] {
  const parts: Part[] = [];
  for (const b of Array.isArray(content) ? content : []) {
    if (b?.type === "text" && b.text) parts.push({ type: "text", content: b.text });
    else if (b?.type === "thinking" && b.thinking && !b.redacted)
      parts.push({ type: "reasoning", content: b.thinking });
    else if (b?.type === "toolCall") parts.push({ type: "tool_call", id: b.id, name: b.name, arguments: b.arguments });
  }
  return parts;
}

/** What an entry adds to the model's context, as Pi's convertToLlm renders it. */
function contextMessage(e: any): Message | undefined {
  if (e.type === "compaction")
    return { id: e.id, role: "user", parts: [{ type: "text", content: asString(e.summary) }] };
  if (e.type === "branch_summary")
    return { id: e.id, role: "user", parts: [{ type: "text", content: asString(e.summary) }] };
  if (e.type === "custom_message") return { id: e.id, role: "user", parts: contentParts(e.content) };
  if (e.type !== "message") return undefined;
  const m = e.message ?? {};
  if (m.role === "user") return { id: e.id, role: "user", parts: contentParts(m.content) };
  if (m.role === "custom") return { id: e.id, role: "user", parts: contentParts(m.content) };
  if (m.role === "toolResult")
    return {
      id: e.id,
      role: "tool",
      parts: [{ type: "tool_call_response", id: m.toolCallId, result: text(m.content) }],
    };
  if (m.role === "bashExecution" && !m.excludeFromContext)
    return { id: e.id, role: "user", parts: [{ type: "text", content: `Ran \`${m.command}\`\n${m.output ?? ""}` }] };
  return undefined;
}

const isAssistant = (e: any) => e?.type === "message" && e.message?.role === "assistant";
const isUser = (e: any) => e?.type === "message" && e.message?.role === "user";
/** Where a run ended. An `error` is not one: Pi retries it within the same run. */
const endsRun = (e: any) => isAssistant(e) && e.message.stopReason !== "toolUse" && e.message.stopReason !== "error";

export function parsePi(path: string, opts: ParseOptions = {}): Session {
  const now = opts.now ?? Date.now();
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const diag = emptyDiagnostics();
  const records: any[] = [];
  const stats = { badLines: 0 };
  for (const r of jsonlRecords(path, stats)) records.push(r);
  diag.badLines = stats.badLines;
  const header = records.find((r) => r?.type === "session") ?? {};
  const sessionId: string =
    header.id ??
    basename(path)
      .replace(/\.jsonl$/, "")
      .split("_")
      .slice(1)
      .join("_");
  const parentFile = typeof header.parentSession === "string" ? header.parentSession : undefined;
  const session: Session = {
    agent: "pi",
    sessionId,
    path,
    cwd: header.cwd,
    parentSessionId:
      parentFile && isPiSession(parentFile) ? basename(parentFile, ".jsonl").replace(/^[^_]+_/, "") : undefined,
    turns: [],
    subagents: [],
    diagnostics: diag,
  };
  const forkedAt = parentFile ? ms(header.timestamp) : -Infinity;

  const byId = new Map<string, any>();
  const entries: any[] = [];
  for (const r of records) {
    if (r?.type === "session" || typeof r?.id !== "string") continue;
    byId.set(r.id, r);
    if (ms(r.timestamp) < forkedAt) diag.inheritedLines++;
    else entries.push(r);
  }
  const parent = (e: any) => (e?.parentId ? byId.get(e.parentId) : undefined);

  const turns = new Map<string, Turn>();
  const turnFor = (e: any): Turn => {
    // The run's start: the nearest user prompt, else the first entry after the previous run ended.
    let child = e;
    let at = parent(e);
    let trigger = "continue";
    while (at) {
      if (isUser(at)) {
        child = at;
        trigger = "user";
        break;
      }
      if (endsRun(at)) break;
      child = at;
      at = parent(at);
    }
    if (trigger !== "user" && child.type === "custom_message") trigger = "extension";
    let turn = turns.get(child.id);
    if (!turn) {
      const start = trigger === "user" ? num(child.message?.timestamp) || ms(child.timestamp) : ms(child.timestamp);
      turn = {
        id: `${sessionId}:${child.id}`,
        index: 0,
        start,
        end: start,
        complete: false,
        prompt: trigger === "user" ? text(child.message?.content) || undefined : undefined,
        trigger,
        apiErrors: 0,
        calls: [],
        tools: [],
        compactions: [],
      };
      turns.set(child.id, turn);
    }
    latest = turn;
    return turn;
  };
  let latest: Turn | undefined;
  /** Side requests (cache warming, compaction, branch summaries) belong to the run going on when they were made. */
  const sideTurn = (e: any): Turn => latest ?? turnFor(e);

  /** Context the call added since the previous request on its branch. */
  const inputOf = (e: any): { input: Message[]; afterCompaction: boolean } => {
    const input: Message[] = [];
    let afterCompaction = false;
    for (let at = parent(e); at && !isAssistant(at); at = parent(at)) {
      if (at.type === "compaction") afterCompaction = true;
      const m = contextMessage(at);
      if (m?.parts.length) input.unshift(m);
    }
    return { input, afterCompaction };
  };

  const tools = new Map<string, ToolCall>();
  let model = "unknown";
  let provider = "unknown";
  const summaryCall = (e: any, kind: string): ModelCall => ({
    id: `${sessionId}:${e.id}`,
    start: ms(e.timestamp),
    end: ms(e.timestamp),
    model,
    provider,
    usage: piUsage(e.usage),
    input: [],
    output: [{ id: e.id, role: "assistant", parts: [{ type: "text", content: asString(e.summary) }] }],
    finishReason: kind,
    complete: true,
  });

  for (const e of entries) {
    if (e.type === "model_change") {
      model = e.modelId ?? model;
      provider = e.provider ?? provider;
      continue;
    }
    if (isUser(e)) {
      turnFor({ parentId: e.id });
      continue;
    }
    if (isAssistant(e)) {
      const m = e.message;
      model = m.model ?? model;
      provider = m.provider ?? provider;
      const turn = turnFor(e);
      if ((m.stopReason === "error" || m.stopReason === "aborted") && !hasTokens(m.usage)) {
        if (m.stopReason === "error") turn.apiErrors++;
        diag.notes.push(`${m.stopReason} without usage in ${e.id}: ${asString(m.errorMessage).slice(0, 120)}`);
        continue;
      }
      const id = `${sessionId}:${e.id}`;
      const end = ms(e.timestamp);
      const start = Math.min(num(m.timestamp) || end, end);
      const { input, afterCompaction } = inputOf(e);
      const parts = outputParts(m.content);
      turn.calls.push({
        id,
        start,
        end,
        model: m.responseModel ?? m.model ?? "unknown",
        provider: m.provider ?? "unknown",
        usage: piUsage(m.usage),
        input,
        output: parts.length ? [{ id, role: "assistant", parts }] : [],
        finishReason: m.stopReason === "toolUse" ? "tool_call" : m.stopReason,
        complete: true,
        afterCompaction: afterCompaction || undefined,
      });
      for (const p of parts) {
        if (p.type !== "tool_call") continue;
        const tool: ToolCall = {
          id: p.id,
          name: p.name,
          start: end,
          arguments: p.arguments,
          argsBytes: byteLength(p.arguments),
          callId: id,
          complete: false,
        };
        tools.set(p.id, tool);
        turn.tools.push(tool);
      }
      continue;
    }
    if (e.type === "message" && e.message?.role === "toolResult") {
      const m = e.message;
      const tool = tools.get(m.toolCallId);
      const result = text(m.content);
      if (tool) {
        tool.end = ms(e.timestamp);
        tool.result = result;
        tool.resultBytes = byteLength(result);
        tool.isError = m.isError === true || undefined;
        tool.complete = true;
      }
      // A tool that called models itself (codemode) reports their usage on its result.
      if (hasTokens(m.usage)) {
        const turn = turnFor(e);
        turn.calls.push({
          id: `${sessionId}:${e.id}:nested`,
          start: tool?.start ?? ms(e.timestamp),
          end: ms(e.timestamp),
          model: "unknown",
          provider: "unknown",
          usage: piUsage(m.usage),
          input: [],
          output: [],
          finishReason: `tool:${m.toolName}`,
          complete: true,
          hidden: true,
        });
      }
      continue;
    }
    if (e.type === "usage") {
      if (!hasTokens(e.usage)) continue;
      sideTurn(e).calls.push({
        id: `${sessionId}:${e.id}`,
        start: ms(e.timestamp),
        end: ms(e.timestamp),
        model: e.model ?? model,
        provider: e.provider ?? provider,
        usage: piUsage(e.usage),
        input: [],
        output: [],
        finishReason: asString(e.kind) || "usage",
        complete: true,
        hidden: true,
      });
      continue;
    }
    if (e.type === "compaction") {
      const turn = sideTurn(e);
      const c: Compaction = {
        id: `${sessionId}:${e.id}`,
        start: ms(e.timestamp),
        end: ms(e.timestamp),
        trigger: e.fromHook ? "extension" : "auto",
        preTokens: e.tokensBefore,
        summaryBytes: byteLength(e.summary),
      };
      turn.compactions.push(c);
      if (hasTokens(e.usage)) turn.calls.push(summaryCall(e, "compaction"));
      continue;
    }
    if (e.type === "branch_summary") {
      if (hasTokens(e.usage)) sideTurn(e).calls.push(summaryCall(e, "branch_summary"));
      continue;
    }
    if (
      ![
        "thinking_level_change",
        "custom",
        "custom_message",
        "label",
        "session_info",
        "context_edit",
        "message",
      ].includes(e.type)
    )
      countKey(diag.unknownRecords, asString(e.type));
  }

  session.turns = [...turns.values()]
    .filter((t) => t.calls.length || t.trigger === "user")
    .toSorted((a, b) => a.start - b.start);
  const idle = now - statSync(path).mtimeMs >= idleMs;
  session.turns.forEach((t, i) => {
    t.index = i;
    t.calls.sort((a, b) => a.end - b.end);
    const last = i === session.turns.length - 1;
    const lastCall = t.calls.findLast((c) => !c.hidden);
    const stopped = lastCall !== undefined && lastCall.finishReason !== "tool_call";
    t.complete = !last || opts.final === true || idle || stopped;
    for (const c of t.calls) t.end = Math.max(t.end, c.end);
    for (const tool of t.tools) t.end = Math.max(t.end, tool.end ?? tool.start);
    for (const tool of t.tools)
      if (!tool.complete && t.complete) {
        tool.complete = true;
        tool.end = t.end;
        tool.isError = true;
      }
  });
  analyzeThread(
    session.turns.flatMap((t) => t.calls.filter((c) => !c.hidden)),
    session.turns.flatMap((t) => t.compactions),
  );
  return session;
}

/** Every usage-bearing record in the file, read naively: what `verify` compares the parser against. */
export function naivePi(path: string): { usage?: Usage; ids: string[] } {
  let usage: Usage | undefined;
  const ids: string[] = [];
  let header: any;
  for (const r of jsonlRecords(path)) {
    if (r?.type === "session") header = r;
    if (header?.parentSession && ms(r?.timestamp) < ms(header.timestamp)) continue;
    const u = r?.type === "message" ? r.message?.usage : r?.usage;
    if (!hasTokens(u)) continue;
    usage = addUsage(usage, piUsage(u));
    ids.push(`${header?.id}:${r.id}${r.message?.role === "toolResult" ? ":nested" : ""}`);
  }
  return { usage, ids };
}
