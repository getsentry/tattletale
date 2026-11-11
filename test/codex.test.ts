import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { parseCodex } from "../src/codex.ts";
import { sumCalls } from "../src/model.ts";
import { otlpEndpoint, sentrySink } from "../src/send.ts";
import { buildSpans, spanAttr } from "../src/spans.ts";
import { at, freshHome, writeJsonl } from "./helpers.ts";

const ID = "01a00000-0000-7000-8000-000000000001";
const u = (input: number, cached: number, output: number, reasoning = 0, write = 0) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  cache_write_input_tokens: write,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
  total_tokens: input + output,
});
const rec = (t: number, type: string, payload: any) => ({ timestamp: at(t), type, payload });
const tc = (t: number, total: any, last: any) =>
  rec(t, "event_msg", { type: "token_count", info: { total_token_usage: total, last_token_usage: last } });
const meta = (extra: any = {}) =>
  rec(0, "session_meta", { id: ID, cwd: "/work/repo", cli_version: "0.150.0", model_provider: "openai", ...extra });
const started = (t: number, id = "turn-1") => rec(t, "event_msg", { type: "task_started", turn_id: id });
const complete = (t: number, id = "turn-1") => rec(t, "event_msg", { type: "task_complete", turn_id: id });
const user = (t: number, text: string) =>
  rec(t, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });
const fcall = (t: number, id: string) =>
  rec(t, "response_item", {
    type: "function_call",
    name: "shell",
    arguments: JSON.stringify({ command: ["ls"] }),
    call_id: id,
  });
const fout = (t: number, id: string) =>
  rec(t, "response_item", { type: "function_call_output", call_id: id, output: "a.txt\nb.txt" });
const say = (t: number, text: string) =>
  rec(t, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const record = (t: number, rid: string, usage: any) => rec(t, "token_usage_record", { response_id: rid, usage });

function file(records: any[]): string {
  const root = freshHome();
  const dir = join(root, "codex", "sessions", "2026", "11", "01");
  mkdirSync(dir, { recursive: true });
  return writeJsonl(join(dir, `rollout-2026-11-01T10-00-00-${ID}.jsonl`), records);
}

test("token_count-only rollouts: per-call usage from cumulative deltas, repeated events ignored", () => {
  const path = file([
    meta(),
    started(1),
    user(1, "list files"),
    fcall(2, "call_1"),
    fout(3, "call_1"),
    tc(3, u(1000, 0, 50, 10), u(1000, 0, 50, 10)),
    tc(3, u(1000, 0, 50, 10), u(1000, 0, 50, 10)), // rate-limit refresh re-emits the same totals
    say(5, "two files"),
    tc(6, u(2500, 900, 80, 10), u(1500, 900, 30, 0)),
    tc(6, u(2500, 900, 80, 10), u(1500, 900, 30, 0)),
    complete(7),
  ]);
  const s = parseCodex(path);
  const calls = s.turns[0]!.calls;
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((c) => [c.usage!.input, c.usage!.cacheRead, c.usage!.output]),
    [
      [1000, 0, 50],
      [1500, 900, 30],
    ],
  );
  const total = sumCalls(calls)!;
  assert.deepEqual([total.input, total.output], [2500, 80], "sum equals Codex's own cumulative total");
  assert.ok(s.turns[0]!.complete);
});

test("forked thread: inherited cumulative total is not charged to the first call", () => {
  const path = file([
    meta({ forked_from_id: "parent" }),
    started(1),
    user(1, "go"),
    say(2, "done"),
    tc(3, u(900_000 + 1200, 800_000, 5000 + 40), u(1200, 0, 40)),
    complete(4),
  ]);
  const s = parseCodex(path);
  assert.equal(s.parentSessionId, "parent");
  assert.deepEqual(
    s.turns[0]!.calls.map((c) => [c.usage!.input, c.usage!.output]),
    [[1200, 40]],
  );
  assert.deepEqual([s.reference!.cumulative!.input, s.reference!.cumulative!.output], [1200, 40]);
});

test("mixed format: exact records where present, cumulative deltas where Codex stopped writing them", () => {
  const path = file([
    meta(),
    started(1),
    user(1, "go"),
    fcall(2, "call_1"),
    record(2, "resp_1", u(1000, 0, 20)),
    fout(3, "call_1"),
    tc(3, u(1000, 0, 20), u(1000, 0, 20)),
    // A different Codex build resumes: no more records.
    fcall(4, "call_2"),
    fout(5, "call_2"),
    tc(5, u(2200, 1000, 50), u(1200, 1000, 30)),
    say(6, "ok"),
    tc(7, u(3500, 2100, 60), u(1300, 1100, 10)),
    complete(8),
  ]);
  const s = parseCodex(path);
  const calls = s.turns[0]!.calls;
  assert.deepEqual(
    calls.map((c) => (c.id.startsWith("resp_") ? c.id : "derived")),
    ["resp_1", "derived", "derived"],
  );
  assert.deepEqual(
    calls.map((c) => c.usage!.input),
    [1000, 1200, 1300],
  );
  assert.equal(sumCalls(calls)!.input, s.reference!.cumulative!.input);
});

test("hidden calls: usage recorded without any persisted output becomes its own call", () => {
  const path = file([
    meta(),
    started(1),
    user(1, "go"),
    fcall(2, "call_1"),
    record(2, "resp_1", u(1000, 0, 20)),
    fout(3, "call_1"),
    record(4, "resp_hidden", u(86000, 85000, 4)), // e.g. a background check: 86k input, 4 output, no items
    say(5, "done"),
    record(6, "resp_2", u(1100, 1000, 30)),
    complete(7),
  ]);
  const s = parseCodex(path);
  const calls = s.turns[0]!.calls;
  assert.deepEqual(
    calls.map((c) => [c.id, !!c.hidden]),
    [
      ["resp_1", false],
      ["resp_hidden", true],
      ["resp_2", false],
    ],
  );
  const spans = buildSpans(s, { content: "full", environment: "test" });
  const hidden = spans.find((x) => spanAttr(x, "gen_ai.response.id") === "resp_hidden")!;
  assert.equal(spanAttr(hidden, "agent.call.hidden"), true);
  assert.equal(spanAttr(hidden, "gen_ai.usage.input_tokens"), 86000);
});

test("sentry sink: OTLP/HTTP JSON, gzip, DSN public key auth", async () => {
  freshHome();
  const dsn = "https://pubkey@o123.ingest.us.sentry.io/456";
  assert.deepEqual(otlpEndpoint(dsn), {
    url: "https://o123.ingest.us.sentry.io/api/456/integration/otlp/v1/traces",
    publicKey: "pubkey",
  });
  let seen: { url: string; headers: any; body: any } | undefined;
  const fakeFetch = (async (url: string, init: any) => {
    seen = { url, headers: init.headers, body: JSON.parse(gunzipSync(init.body).toString()) };
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const span = {
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    name: "x",
    kind: 1,
    startTimeUnixNano: "1",
    endTimeUnixNano: "2",
    attributes: [],
    status: { code: 1 },
  };
  const res = await sentrySink(dsn, fakeFetch).send([span]);
  assert.equal(res.ok, true);
  assert.equal(seen!.url, "https://o123.ingest.us.sentry.io/api/456/integration/otlp/v1/traces");
  assert.match(seen!.headers["x-sentry-auth"], /sentry_key=pubkey/);
  assert.equal(seen!.body.resourceSpans[0].scopeSpans[0].spans[0].spanId, "b".repeat(16));
});

test("error reports: envelope to the DSN with in-app frames from the .ts sources", async () => {
  freshHome();
  const { reportError, parseStack } = await import("../src/report.ts");
  let seen: { url: string; headers: any; body: string } | undefined;
  const fakeFetch = (async (url: string, init: any) => {
    seen = { url, headers: init.headers, body: init.body };
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const id = await reportError(new Error("boom"), { stage: "test" }, fakeFetch);
  assert.match(id!, /^[0-9a-f]{32}$/);
  assert.equal(seen!.url, "https://o1.ingest.example.com/api/42/envelope/");
  assert.match(seen!.headers["x-sentry-auth"], /sentry_key=abc123/);
  const [header, item, event] = seen!.body.split("\n").map((l) => JSON.parse(l));
  assert.equal(header.event_id, id);
  assert.equal(item.type, "event");
  assert.equal(event.exception.values[0].value, "boom");
  const frames = parseStack(new Error("x").stack);
  assert.ok(
    frames.at(-1)!.in_app && frames.at(-1)!.filename!.endsWith("codex.test.ts"),
    "innermost frame is last and in-app",
  );
});

test("a later response's usage never lands on an older call that lost its own", () => {
  const path = file([
    meta(),
    started(1),
    user(1, "go"),
    fcall(2, "call_s"), // S: its usage record was never written
    fout(3, "call_s"),
    fcall(4, "call_x"),
    record(4, "resp_x", u(1000, 0, 20)),
    fout(5, "call_x"),
    tc(5, u(1000, 0, 20), u(1000, 0, 20)), // covered by resp_x's record
    say(6, "thinking out loud"), // Y: no record either, only the cumulative delta
    tc(7, u(2500, 900, 50), u(1500, 900, 30)),
    complete(8),
  ]);
  const calls = parseCodex(path).turns[0]!.calls;
  const byTool = (id: string) =>
    calls.find((c) => c.output[0]?.parts.some((p) => p.type === "tool_call" && p.id === id))!;
  assert.equal(byTool("call_s").usage, undefined, "S keeps no usage instead of stealing Y's");
  const y = calls.at(-1)!;
  assert.deepEqual([y.usage!.input, y.usage!.output], [1500, 30]);
  assert.ok(y.end - y.start < 10_000, "Y's span is not stretched to an unrelated event");
});

test("code mode: an exec script's inner tools and first command are named on its tool span", () => {
  const script =
    'const r = await tools.exec_command({cmd:"sed -n \'1,200p\' calc.py",workdir:"/work/proj"});\n' +
    'const p = await tools.apply_patch("*** Begin Patch");\nawait tools.exec_command({cmd:"python3 -m pytest"});';
  const path = file([
    meta(),
    started(1),
    user(1, "fix calc"),
    rec(2, "response_item", {
      type: "custom_tool_call",
      call_id: "call_js",
      name: "exec",
      namespace: "functions",
      input: script,
    }),
    record(2, "resp_1", u(1000, 0, 40)),
    rec(3, "response_item", {
      type: "custom_tool_call_output",
      call_id: "call_js",
      output: [{ type: "input_text", text: "Script completed" }],
    }),
    say(4, "fixed"),
    record(4, "resp_2", u(1100, 900, 10)),
    complete(5),
  ]);
  const tool = buildSpans(parseCodex(path), { content: "full", environment: "test" }).find(
    (s) => spanAttr(s, "gen_ai.operation.name") === "execute_tool",
  )!;
  assert.equal(spanAttr(tool, "gen_ai.tool.name"), "functions__exec");
  assert.equal(spanAttr(tool, "agent.tool.calls"), "exec_command,apply_patch");
  assert.equal(spanAttr(tool, "agent.tool.command"), "sed -n '1,200p' calc.py");
});
