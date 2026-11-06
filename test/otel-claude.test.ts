import assert from "node:assert/strict";
import { test } from "node:test";
import { mapClaudeOtel } from "../src/otel-claude.ts";
import { spanAttr } from "../src/spans.ts";

const s = (v: string) => ({ stringValue: v });
const i = (v: number) => ({ intValue: String(v) });
const attrs = (o: Record<string, any>) => Object.entries(o).map(([key, value]) => ({ key, value }));
const span = (
  id: string,
  parent: string | undefined,
  name: string,
  t: number,
  a: Record<string, any>,
  events?: any[],
) => ({
  traceId: "t".repeat(32),
  spanId: id,
  parentSpanId: parent,
  name,
  kind: 1,
  startTimeUnixNano: String(BigInt(t) * 1_000_000n),
  endTimeUnixNano: String(BigInt(t + 500) * 1_000_000n),
  attributes: attrs({ "gen_ai.conversation.id": s("conv"), "user.email": s("me@example.com"), ...a }),
  status: { code: 1 },
  events,
});
const log = (a: Record<string, any>) => ({ attributes: attrs(a) });

test("Claude Code native OTel maps onto Sentry's gen_ai conventions", () => {
  const traces = [
    {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                span("root", undefined, "claude_code.interaction", 0, {
                  "gen_ai.operation.name": s("invoke_agent"),
                  user_prompt: s("make a file"),
                }),
                span("llm1", "root", "claude_code.llm_request", 10, {
                  model: s("claude-haiku-5-5"),
                  request_id: s("req_1"),
                  input_tokens: i(2),
                  cache_read_tokens: i(100),
                  cache_creation_tokens: i(50),
                  output_tokens: i(30),
                  ttft_ms: i(400),
                }),
                span(
                  "tool1",
                  "root",
                  "claude_code.tool",
                  600,
                  {
                    "gen_ai.operation.name": s("execute_tool"),
                    "gen_ai.tool.name": s("Write"),
                    tool_name: s("Write"),
                    tool_use_id: s("toolu_1"),
                  },
                  [{ name: "tool.output", attributes: attrs({ content: s("written") }) }],
                ),
                span("llm2", "root", "claude_code.llm_request", 1200, {
                  model: s("claude-haiku-5-5"),
                  request_id: s("req_2"),
                  input_tokens: i(1),
                  cache_read_tokens: i(150),
                  cache_creation_tokens: i(5),
                  output_tokens: i(10),
                }),
              ],
            },
          ],
        },
      ],
    },
  ];
  const logs = [
    {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                log({ "event.name": s("assistant_response"), request_id: s("req_2"), response: s("done") }),
                log({
                  "event.name": s("tool_result"),
                  tool_use_id: s("toolu_1"),
                  tool_input: s('{"file_path":"a.txt"}'),
                }),
              ],
            },
          ],
        },
      ],
    },
  ];
  const out = mapClaudeOtel({ traces, logs });
  const byId = (id: string) => out.find((x) => x.spanId === id)!;

  const c1 = byId("llm1");
  assert.equal(c1.name, "chat claude-haiku-5-5");
  assert.equal(spanAttr(c1, "gen_ai.operation.name"), "chat");
  assert.equal(spanAttr(c1, "gen_ai.usage.input_tokens"), 152, "input includes cache reads and writes");
  assert.equal(spanAttr(c1, "gen_ai.usage.cache_read.input_tokens"), 100);
  assert.equal(spanAttr(c1, "gen_ai.response.time_to_first_chunk"), 0.4);
  assert.match(String(spanAttr(c1, "gen_ai.input.messages")), /make a file/);
  assert.match(String(spanAttr(c1, "gen_ai.output.messages")), /"tool_call".*"Write"/);
  const c2 = byId("llm2");
  assert.match(String(spanAttr(c2, "gen_ai.input.messages")), /"role":"tool".*written/);
  assert.match(String(spanAttr(c2, "gen_ai.output.messages")), /done/);
  const t = byId("tool1");
  assert.equal(t.name, "execute_tool Write");
  assert.equal(spanAttr(t, "gen_ai.tool.call.result"), "written");
  assert.match(String(spanAttr(t, "gen_ai.tool.call.arguments")), /a\.txt/);
  assert.equal(byId("root").name, "invoke_agent claude-code");
  assert.ok(
    out.every((x) => !x.attributes.some((a) => a.key === "user.email")),
    "personal fields dropped",
  );
});

test("subagent spans join the parent session's conversation", () => {
  const traces = [
    {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                span("sub", undefined, "claude_code.llm_request", 0, {
                  "gen_ai.conversation.id": s("agent123"),
                  agent_id: s("agent123"),
                  "session.id": s("session-1"),
                  model: s("m"),
                  input_tokens: i(1),
                  output_tokens: i(1),
                }),
              ],
            },
          ],
        },
      ],
    },
  ];
  const [sub] = mapClaudeOtel({ traces, logs: [] });
  assert.equal(spanAttr(sub!, "gen_ai.conversation.id"), "session-1");
});
