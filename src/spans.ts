// Session -> OTLP spans in Sentry's gen_ai conventions.
//
// Shape: one conversation per session (gen_ai.conversation.id), one trace per turn:
//   invoke_agent <agent>                  turn root, sent once the turn is complete
//   ├─ chat <model>                       one per model call, only that call's new input messages
//   ├─ execute_tool <tool>                one per tool call
//   │  └─ invoke_agent <subagent type>    subagent launched by that tool, with its own chat/tool spans
//   └─ compact                            context compaction
//
// Every ID is derived only from globally unique transcript IDs (never the session ID), so the same call
// copied into another session (resume/fork rewrites) maps to the same span and the ledger sends it once.
// Turn totals use agent.turn.* names (not gen_ai.usage.*) so summing gen_ai.usage.* never double counts.

import type { Compaction, Message, ModelCall, Run, Session, SubagentRun, ToolCall } from "./model.ts";
import { sumCalls } from "./model.ts";
import { asString, scrub, spanIdFor, traceIdFor, truncate } from "./util.ts";

export type ContentMode = "full" | "metadata";

export interface SpanOptions {
  content: ContentMode;
  environment: string;
  user?: string;
}

export interface OtlpAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean };
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status: { code: number; message?: string };
}

type Attrs = Record<string, string | number | boolean | undefined | null>;

const KIND_INTERNAL = 1;
const KIND_CLIENT = 3;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

const LIMIT_TEXT = 16 * 1024;
const LIMIT_TOOL = 8 * 1024;
const LIMIT_MESSAGES = 96 * 1024;
const LIMIT_PREVIEW = 1024;

function toAttributes(attrs: Attrs): OtlpAttribute[] {
  const out: OtlpAttribute[] = [];
  for (const [key, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "boolean") out.push({ key, value: { boolValue: v } });
    else if (typeof v === "number") {
      if (!Number.isFinite(v)) continue;
      out.push({ key, value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } });
    } else out.push({ key, value: { stringValue: v } });
  }
  return out;
}

const nanos = (ms: number): string => (BigInt(Math.round(ms)) * 1_000_000n).toString();

function span(
  traceId: string,
  spanId: string,
  parentSpanId: string | undefined,
  name: string,
  kind: number,
  start: number,
  end: number,
  attrs: Attrs,
  error?: string,
): OtlpSpan {
  return {
    traceId,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name,
    kind,
    startTimeUnixNano: nanos(start),
    endTimeUnixNano: nanos(Math.max(start, end)),
    attributes: toAttributes(attrs),
    status: error ? { code: STATUS_ERROR, message: error } : { code: STATUS_OK },
  };
}

const clean = (text: string, limit: number): string => scrub(truncate(text, limit));

/** JSON for gen_ai.input/output.messages. Shrinks parts until the whole attribute fits. */
export function renderMessages(all: Message[]): string | undefined {
  const messages = all.filter((m) => m.parts.length);
  if (!messages.length) return undefined;
  let textLimit = LIMIT_TEXT;
  let toolLimit = LIMIT_TOOL;
  for (let attempt = 0; attempt < 6; attempt++) {
    const rendered = JSON.stringify(
      messages.map((m) => ({
        id: m.id,
        role: m.role,
        parts: m.parts.map((p) => {
          switch (p.type) {
            case "text":
            case "reasoning":
              return { type: p.type, content: clean(p.content, textLimit) };
            case "tool_call":
              return { type: p.type, id: p.id, name: p.name, arguments: clean(asString(p.arguments), toolLimit) };
            case "tool_call_response":
              return { type: p.type, id: p.id, result: clean(asString(p.result), toolLimit) };
            default:
              return p;
          }
        }),
      })),
    );
    if (Buffer.byteLength(rendered) <= LIMIT_MESSAGES) return rendered;
    textLimit = Math.max(256, Math.floor(textLimit / 2));
    toolLimit = Math.max(256, Math.floor(toolLimit / 2));
  }
  return undefined;
}

function mostCommonModel(calls: ModelCall[]): string | undefined {
  const counts = new Map<string, number>();
  for (const c of calls) counts.set(c.model, (counts.get(c.model) ?? 0) + 1);
  return [...counts.entries()].toSorted((a, b) => b[1] - a[1])[0]?.[0];
}

function toolDetails(tool: ToolCall): Attrs {
  const args = (tool.arguments ?? {}) as any;
  const attrs: Attrs = {};
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool.name);
  if (mcp) attrs["agent.tool.mcp_server"] = mcp[1];
  if (typeof args === "object" && args) {
    if (typeof args.file_path === "string") attrs["agent.tool.file_path"] = args.file_path;
    else if (typeof args.notebook_path === "string") attrs["agent.tool.file_path"] = args.notebook_path;
    else if (typeof args.path === "string") attrs["agent.tool.file_path"] = args.path;
    if (typeof args.command === "string") attrs["agent.tool.command"] = clean(args.command, 300);
    else if (Array.isArray(args.command)) attrs["agent.tool.command"] = clean(args.command.join(" "), 300);
    else if (typeof args.cmd === "string") attrs["agent.tool.command"] = clean(args.cmd, 300);
    if (typeof args.pattern === "string") attrs["agent.tool.pattern"] = clean(args.pattern, 300);
    if (typeof args.subagent_type === "string") attrs["agent.tool.subagent_type"] = args.subagent_type;
  } else if (typeof args === "string" && /(^|__)exec$/.test(tool.name)) {
    // Codex code mode: one JS `exec` tool runs a script that calls the real tools (`tools.exec_command(...)`).
    const calls = [...new Set([...args.matchAll(/\btools\.([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]!))];
    if (calls.length) attrs["agent.tool.calls"] = calls.join(",");
    const cmd = /\bcmd\s*:\s*("(?:[^"\\]|\\.)*")/.exec(args)?.[1];
    if (cmd) {
      try {
        attrs["agent.tool.command"] = clean(JSON.parse(cmd), 300);
      } catch {}
    }
  }
  return attrs;
}

function runTotals(run: Run, prefix: string): Attrs {
  const main = run.calls.filter((c) => !c.sidechain);
  const u = sumCalls(main);
  return {
    [`${prefix}.model_calls`]: main.length,
    [`${prefix}.tool_calls`]: run.tools.length,
    [`${prefix}.input_tokens`]: u?.input ?? 0,
    [`${prefix}.output_tokens`]: u?.output ?? 0,
    [`${prefix}.cache_read_tokens`]: u?.cacheRead ?? 0,
    [`${prefix}.cache_write_tokens`]: u?.cacheWrite ?? 0,
    [`${prefix}.compactions`]: run.compactions.length,
  };
}

export function buildSpans(session: Session, opts: SpanOptions): OtlpSpan[] {
  const conv = session.sessionId;
  const full = opts.content === "full";
  const common: Attrs = {
    "gen_ai.conversation.id": conv,
    "sentry.environment": opts.environment,
    "sentry.release": session.agentVersion ? `${session.agent}@${session.agentVersion}` : undefined,
    "agent.name": session.agent,
    "agent.session.id": session.sessionId,
    "agent.session.parent_id": session.parentSessionId,
    "agent.session.cwd": session.cwd,
    "agent.session.entrypoint": session.entrypoint,
    "vcs.ref.head.name": session.gitBranch,
    "vcs.repository.name": session.repo,
    "user.id": opts.user,
  };
  const spans: OtlpSpan[] = [];
  const toolSpanRef = new Map<string, { traceId: string; spanId: string }>();

  const chatSpan = (call: ModelCall, traceId: string, parent: string, agentName: string): OtlpSpan => {
    const u = call.usage;
    const a = call.analysis;
    const toolCalls = call.output.reduce((n, m) => n + m.parts.filter((p) => p.type === "tool_call").length, 0);
    const attrs: Attrs = {
      ...common,
      "sentry.op": "gen_ai.chat",
      "gen_ai.operation.name": "chat",
      "gen_ai.agent.name": agentName,
      "gen_ai.provider.name": call.provider,
      "gen_ai.request.model": call.model,
      "gen_ai.response.model": call.model,
      "gen_ai.response.id": call.id,
      "gen_ai.response.finish_reasons": call.finishReason ? JSON.stringify([call.finishReason]) : undefined,
      "gen_ai.usage.input_tokens": u?.input,
      "gen_ai.usage.cache_read.input_tokens": u?.cacheRead,
      "gen_ai.usage.cache_creation.input_tokens": u?.cacheWrite,
      "gen_ai.usage.output_tokens": u?.output,
      "gen_ai.usage.reasoning.output_tokens": u?.reasoning,
      "gen_ai.usage.total_tokens": u ? u.input + u.output : undefined,
      "gen_ai.input.messages": full ? renderMessages(call.input) : undefined,
      "gen_ai.output.messages": full ? renderMessages(call.output) : undefined,
      "agent.call.usage_missing": u ? undefined : true,
      "agent.call.tool_calls": toolCalls,
      "agent.call.idle_seconds": a?.idleMs !== undefined ? Math.round(a.idleMs / 1000) : undefined,
      "agent.call.context_growth_tokens": a?.contextGrowth,
      "agent.call.uncached_input_tokens": a?.uncachedInput,
      "agent.call.cache_break": a ? a.cacheBreak : undefined,
      "agent.call.cache_read_drop_tokens": a?.cacheReadDrop,
      "agent.call.compacted_before": a?.compactedBefore,
      "agent.call.hidden": call.hidden,
      "agent.call.sidechain": call.sidechain,
    };
    for (const [k, v] of Object.entries(u?.extra ?? {})) attrs[`agent.usage.${k}`] = v;
    return span(
      traceId,
      spanIdFor("chat", session.agent, call.id),
      parent,
      `chat ${call.model}`,
      KIND_CLIENT,
      call.start,
      call.end,
      attrs,
    );
  };

  const toolSpan = (tool: ToolCall, traceId: string, parent: string, agentName: string): OtlpSpan => {
    const spanId = spanIdFor("tool", session.agent, tool.id);
    toolSpanRef.set(tool.id, { traceId, spanId });
    const attrs: Attrs = {
      ...common,
      "sentry.op": "gen_ai.execute_tool",
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.agent.name": agentName,
      "gen_ai.tool.name": tool.name,
      "gen_ai.tool.type": "function",
      "gen_ai.tool.call.id": tool.id,
      "gen_ai.tool.call.arguments": full ? clean(asString(tool.arguments), LIMIT_TOOL) : undefined,
      "gen_ai.tool.call.result":
        full && tool.result !== undefined ? clean(asString(tool.result), LIMIT_TOOL) : undefined,
      "agent.tool.args_bytes": tool.argsBytes,
      "agent.tool.result_bytes": tool.resultBytes,
      "agent.tool.result_tokens_est": tool.resultBytes !== undefined ? Math.ceil(tool.resultBytes / 4) : undefined,
      "agent.tool.model_call_id": tool.callId,
      "agent.tool.unfinished": tool.result === undefined && !tool.serverSide ? true : undefined,
      "agent.tool.server_side": tool.serverSide,
      ...toolDetails(tool),
    };
    const error = tool.isError ? (tool.result === undefined ? "unfinished" : "tool_error") : undefined;
    return span(
      traceId,
      spanId,
      parent,
      `execute_tool ${tool.name}`,
      KIND_INTERNAL,
      tool.start,
      tool.end ?? tool.start,
      attrs,
      error,
    );
  };

  const compactSpan = (c: Compaction, traceId: string, parent: string): OtlpSpan =>
    span(traceId, spanIdFor("compact", session.agent, c.id), parent, "compact", KIND_INTERNAL, c.start, c.end, {
      ...common,
      "sentry.op": "gen_ai.compact",
      "gen_ai.operation.name": "compact",
      "agent.compaction.trigger": c.trigger,
      "agent.compaction.pre_tokens": c.preTokens,
      "agent.compaction.post_tokens": c.postTokens,
      "agent.compaction.summary_bytes": c.summaryBytes,
    });

  const emitChildren = (run: Run, traceId: string, parent: string, agentName: string) => {
    for (const call of run.calls) if (call.complete) spans.push(chatSpan(call, traceId, parent, agentName));
    for (const tool of run.tools) if (tool.complete) spans.push(toolSpan(tool, traceId, parent, agentName));
    for (const c of run.compactions) spans.push(compactSpan(c, traceId, parent));
  };

  for (const turn of session.turns) {
    const traceId = traceIdFor(session.agent, turn.id);
    const rootId = spanIdFor("turn", session.agent, turn.id);
    if (turn.complete) {
      spans.push(
        span(traceId, rootId, undefined, `invoke_agent ${session.agent}`, KIND_INTERNAL, turn.start, turn.end, {
          ...common,
          "sentry.op": "gen_ai.invoke_agent",
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": session.agent,
          "gen_ai.request.model": mostCommonModel(turn.calls),
          "agent.turn.id": turn.id,
          "agent.turn.index": turn.index,
          "agent.turn.trigger": turn.trigger,
          "agent.turn.prompt": full && turn.prompt ? clean(turn.prompt, LIMIT_PREVIEW) : undefined,
          "agent.turn.api_errors": turn.apiErrors || undefined,
          ...runTotals(turn, "agent.turn"),
        }),
      );
    }
    emitChildren(turn, traceId, rootId, session.agent);
  }

  // Subagents hang off the tool call that launched them, which may itself be inside another subagent.
  const pending = [...session.subagents];
  for (let pass = 0; pending.length && pass < 8; pass++) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const run = pending[i]!;
      const ref = run.parentToolId ? toolSpanRef.get(run.parentToolId) : undefined;
      if (!ref && pass < 7) continue;
      pending.splice(i, 1);
      emitSubagent(run, ref);
    }
  }

  function emitSubagent(run: SubagentRun, ref: { traceId: string; spanId: string } | undefined): void {
    const traceId = ref?.traceId ?? traceIdFor(session.agent, "subagent", run.agentId);
    const rootId = spanIdFor("subagent", session.agent, run.agentId);
    if (run.complete) {
      spans.push(
        span(traceId, rootId, ref?.spanId, `invoke_agent ${run.agentType}`, KIND_INTERNAL, run.start, run.end, {
          ...common,
          "sentry.op": "gen_ai.invoke_agent",
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": run.agentType,
          "gen_ai.request.model": mostCommonModel(run.calls),
          "agent.subagent.id": run.agentId,
          "agent.subagent.description": run.description,
          ...runTotals(run, "agent.subagent"),
        }),
      );
    }
    emitChildren(run, traceId, rootId, run.agentType);
  }

  // Guard against ever emitting the same span twice from one build.
  const seen = new Set<string>();
  return spans.filter((s) => (seen.has(s.spanId) ? false : (seen.add(s.spanId), true)));
}

export function spanAttr(s: OtlpSpan, key: string): string | number | boolean | undefined {
  const v = s.attributes.find((a) => a.key === key)?.value;
  if (!v) return undefined;
  if (v.intValue !== undefined) return Number(v.intValue);
  return v.stringValue ?? v.doubleValue ?? v.boolValue;
}
