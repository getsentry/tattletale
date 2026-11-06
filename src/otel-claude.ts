// Rewrites Claude Code's native OpenTelemetry (claude_code.* spans + log events) into Sentry's gen_ai
// conventions. Spans carry structure, timing and token counts under custom names; prompt, response and
// tool text arrive as log events or span events, so they are joined back onto the spans here.
//
// Mapping:
//   claude_code.interaction  -> invoke_agent claude-code   (turn root)
//   claude_code.llm_request  -> chat <model>                (usage renamed, input includes cache, messages joined)
//   claude_code.tool         -> execute_tool <tool>         (arguments from tool_result logs, output from tool.output events)
//   tool.execution / tool.blocked_on_user                   kept as plain child spans
//   subagent spans                                          moved into the parent session's conversation
// Personal fields (email, account IDs) are dropped.

import type { OtlpAttribute, OtlpSpan } from "./spans.ts";
import { renderMessages } from "./spans.ts";
import type { Message } from "./model.ts";
import { scrub, truncate } from "./util.ts";

type Attrs = Record<string, unknown>;
interface Span extends OtlpSpan {
  a: Attrs;
  events?: { name: string; timeUnixNano?: string; attributes?: OtlpAttribute[] }[];
}

const DROP = new Set(["user.email", "user.account_uuid", "user.account_id", "organization.id"]);
const LIMIT = 8 * 1024;

function value(v: any): unknown {
  if (!v) return undefined;
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("boolValue" in v) return v.boolValue;
  return undefined;
}

const toMap = (list: OtlpAttribute[] | undefined): Attrs =>
  Object.fromEntries((list ?? []).map((x) => [x.key, value(x.value)]));

function fromMap(m: Attrs): OtlpAttribute[] {
  const out: OtlpAttribute[] = [];
  for (const [key, v] of Object.entries(m)) {
    if (v === undefined || v === null || v === "" || DROP.has(key)) continue;
    if (typeof v === "number")
      out.push({ key, value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } });
    else if (typeof v === "boolean") out.push({ key, value: { boolValue: v } });
    else out.push({ key, value: { stringValue: String(v) } });
  }
  return out;
}

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);
const ns = (s: { startTimeUnixNano: string }) => BigInt(s.startTimeUnixNano);
const clean = (t: unknown) => scrub(truncate(typeof t === "string" ? t : JSON.stringify(t ?? ""), LIMIT));

export interface ClaudeOtelInput {
  /** OTLP/JSON ExportTraceServiceRequest bodies. */
  traces: any[];
  /** OTLP/JSON ExportLogsServiceRequest bodies. */
  logs: any[];
}

export function mapClaudeOtel(input: ClaudeOtelInput): OtlpSpan[] {
  const spans: Span[] = [];
  for (const body of input.traces)
    for (const rs of body.resourceSpans ?? [])
      for (const ss of rs.scopeSpans ?? [])
        for (const s of ss.spans ?? []) spans.push({ ...s, a: toMap(s.attributes) });

  // Log events, indexed by the IDs that tie them to spans.
  const responseByRequest = new Map<string, string>();
  const toolInputById = new Map<string, unknown>();
  const agentTypeById = new Map<string, string>();
  const cacheSplitByRequest = new Map<string, { m5: number; h1: number }>();
  for (const body of input.logs)
    for (const rl of body.resourceLogs ?? [])
      for (const sl of rl.scopeLogs ?? [])
        for (const r of sl.logRecords ?? []) {
          const a = toMap(r.attributes);
          const event = String(a["event.name"] ?? "");
          if (event === "assistant_response" && a.request_id)
            responseByRequest.set(String(a.request_id), String(a.response ?? ""));
          if (event === "tool_result" && a.tool_use_id)
            toolInputById.set(String(a.tool_use_id), a.tool_input ?? a.tool_parameters);
          if (event === "subagent_completed" && a.agent_id)
            agentTypeById.set(String(a.agent_id), String(a.agent_type ?? "subagent"));
          if (event === "api_request" && a.request_id)
            cacheSplitByRequest.set(String(a.request_id), {
              m5: num(a.cache_creation_5m_tokens),
              h1: num(a.cache_creation_1h_tokens),
            });
        }

  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const interactionOf = (s: Span): Span | undefined => {
    for (let cur: Span | undefined = s; cur; cur = cur.parentSpanId ? byId.get(cur.parentSpanId) : undefined)
      if (cur.name === "claude_code.interaction") return cur;
    return undefined;
  };
  const thread = (s: Span) => `${interactionOf(s)?.spanId ?? "?"}|${String(s.a.agent_id ?? "main")}`;
  const toolOutput = (s: Span) => {
    const ev = s.events?.find((e) => e.name === "tool.output");
    const a = toMap(ev?.attributes);
    return a.output ?? a.content ?? a.result ?? Object.values(a).find((v) => typeof v === "string");
  };

  // Order model calls and tool calls per thread (main agent or one subagent within a turn).
  const threads = new Map<string, { llm: Span[]; tools: Span[] }>();
  for (const s of spans) {
    if (s.name !== "claude_code.llm_request" && s.name !== "claude_code.tool") continue;
    const key =
      s.name === "claude_code.tool"
        ? `${interactionOf(s)?.spanId ?? "?"}|${String(s.a.agent_id ?? "main")}`
        : thread(s);
    const t = threads.get(key) ?? { llm: [], tools: [] };
    (s.name === "claude_code.llm_request" ? t.llm : t.tools).push(s);
    threads.set(key, t);
  }
  const inputOf = new Map<string, Message[]>();
  const outputOf = new Map<string, Message[]>();
  for (const [key, t] of threads) {
    t.llm.sort((x, y) => (ns(x) < ns(y) ? -1 : 1));
    t.tools.sort((x, y) => (ns(x) < ns(y) ? -1 : 1));
    t.llm.forEach((call, i) => {
      const next = t.llm[i + 1];
      const prev = t.llm[i - 1];
      const newInput: Message[] = [];
      if (!prev) {
        const prompt = key.endsWith("|main") ? interactionOf(call)?.a.user_prompt : undefined;
        if (prompt)
          newInput.push({
            id: `${call.spanId}:prompt`,
            role: "user",
            parts: [{ type: "text", content: String(prompt) }],
          });
      } else {
        const results = t.tools.filter((tool) => ns(tool) >= ns(prev) && ns(tool) < ns(call));
        if (results.length)
          newInput.push({
            id: `${call.spanId}:tools`,
            role: "tool",
            parts: results.map((tool) => ({
              type: "tool_call_response" as const,
              id: String(tool.a.tool_use_id ?? ""),
              result: clean(toolOutput(tool) ?? ""),
            })),
          });
      }
      const calls = t.tools.filter((tool) => ns(tool) >= ns(call) && (!next || ns(tool) < ns(next)));
      const text = responseByRequest.get(String(call.a.request_id ?? ""));
      const parts: Message["parts"] = [];
      if (text) parts.push({ type: "text", content: text });
      for (const tool of calls)
        parts.push({
          type: "tool_call",
          id: String(tool.a.tool_use_id ?? ""),
          name: String(tool.a.tool_name ?? tool.a["gen_ai.tool.name"] ?? "tool"),
          arguments: toolInputById.get(String(tool.a.tool_use_id ?? "")) ?? {},
        });
      inputOf.set(call.spanId, newInput);
      outputOf.set(
        call.spanId,
        parts.length ? [{ id: String(call.a["gen_ai.response.id"] ?? call.spanId), role: "assistant", parts }] : [],
      );
    });
  }

  const out: OtlpSpan[] = [];
  for (const s of spans) {
    const a: Attrs = { ...s.a };
    // Claude Code puts the subagent's own ID in gen_ai.conversation.id; Sentry would split it into its own conversation.
    if (a.agent_id && a["session.id"]) a["gen_ai.conversation.id"] = a["session.id"];
    let name = s.name;
    const agentName = a.agent_id ? (agentTypeById.get(String(a.agent_id)) ?? "subagent") : "claude-code";
    if (s.name === "claude_code.interaction") {
      Object.assign(a, {
        "sentry.op": "gen_ai.invoke_agent",
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": "claude-code",
      });
      name = "invoke_agent claude-code";
    } else if (s.name === "claude_code.llm_request") {
      const fresh = num(a.input_tokens);
      const read = num(a.cache_read_tokens);
      const write = num(a.cache_creation_tokens);
      const split = cacheSplitByRequest.get(String(a.request_id ?? ""));
      Object.assign(a, {
        "sentry.op": "gen_ai.chat",
        "gen_ai.operation.name": "chat",
        "gen_ai.agent.name": agentName,
        "gen_ai.response.model": a.model ?? a["gen_ai.request.model"],
        // Anthropic's input_tokens excludes cache reads and writes; Sentry's includes them.
        "gen_ai.usage.input_tokens": fresh + read + write,
        "gen_ai.usage.cache_read.input_tokens": read,
        "gen_ai.usage.cache_creation.input_tokens": write,
        "gen_ai.usage.output_tokens": num(a.output_tokens),
        "gen_ai.usage.total_tokens": fresh + read + write + num(a.output_tokens),
        "gen_ai.response.time_to_first_chunk": a.ttft_ms !== undefined ? num(a.ttft_ms) / 1000 : undefined,
        "gen_ai.input.messages": renderMessages(inputOf.get(s.spanId) ?? []),
        "gen_ai.output.messages": renderMessages(outputOf.get(s.spanId) ?? []),
        "agent.usage.cache_write_5m": split?.m5,
        "agent.usage.cache_write_1h": split?.h1,
      });
      name = `chat ${a.model ?? a["gen_ai.request.model"]}`;
    } else if (s.name === "claude_code.tool") {
      const output = toolOutput(s);
      Object.assign(a, {
        "sentry.op": "gen_ai.execute_tool",
        "gen_ai.agent.name": agentName,
        "gen_ai.tool.call.arguments": clean(
          toolInputById.get(String(a.tool_use_id ?? "")) ?? a.full_command ?? a.file_path ?? "",
        ),
        "gen_ai.tool.call.result": output !== undefined ? clean(output) : undefined,
      });
      name = `execute_tool ${a["gen_ai.tool.name"] ?? a.tool_name}`;
    }
    const { a: _a, events: _e, attributes: _x, ...rest } = s as any;
    out.push({ ...rest, name, attributes: fromMap(a) });
  }
  return out;
}
