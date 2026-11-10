import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseClaude } from "../src/claude.ts";
import { sumCalls } from "../src/model.ts";
import { memorySink } from "../src/send.ts";
import type { OtlpSpan } from "../src/spans.ts";
import { buildSpans, spanAttr } from "../src/spans.ts";
import { loadSent, recoverPending, writePending } from "../src/state.ts";
import { syncTranscript } from "../src/sync.ts";
import { appendJsonl, cc, claudeProject, freshHome, usage, writeJsonl } from "./helpers.ts";

const S = "11111111-1111-4111-8111-111111111111";

/** Turn 1: a tool-using call split over two lines + a final answer, closed by a stop marker. Turn 2: one call, still open. */
function baseSession(sessionId = S) {
  return [
    cc.prompt(sessionId, "u1", 0, "fix the bug"),
    cc.assistant(sessionId, "a1", 2, "msg_A", { type: "thinking", thinking: "look at file" }, usage(10, 100, 5, 20)),
    cc.assistant(
      sessionId,
      "a2",
      3,
      "msg_A",
      { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/work/repo/x.ts" } },
      usage(10, 100, 5, 20),
    ),
    cc.toolResult(sessionId, "r1", 4, "toolu_1", "const x = 1;\n".repeat(50)),
    cc.assistant(sessionId, "a3", 6, "msg_B", { type: "text", text: "fixed" }, usage(2, 300, 10, 7)),
    cc.stopMarker(sessionId, "m1", 7),
    cc.prompt(sessionId, "u2", 60, "now add a test"),
    cc.assistant(sessionId, "a4", 62, "msg_C", { type: "text", text: "on it" }, usage(3, 400, 0, 9)),
  ];
}

const names = (spans: OtlpSpan[]) => spans.map((s) => s.name).toSorted();
const sent = (sink: ReturnType<typeof memorySink>) => sink.batches.flat();

test("tokens: one API response split over lines counts once; input includes cache (Sentry convention)", () => {
  const root = freshHome();
  const path = writeJsonl(join(claudeProject(root), `${S}.jsonl`), baseSession());
  const session = parseClaude(path, { final: true });
  const calls = session.turns.flatMap((t) => t.calls);
  assert.deepEqual(
    calls.map((c) => c.id),
    ["msg_A", "msg_B", "msg_C"],
  );
  const a = calls[0]!.usage!;
  assert.equal(a.input, 10 + 100 + 5);
  assert.equal(a.cacheRead, 100);
  assert.equal(a.cacheWrite, 5);
  assert.equal(a.output, 20);
  assert.equal(a.extra?.cache_write_1h, 5);
  const total = sumCalls(calls)!;
  assert.deepEqual([total.input, total.cacheRead, total.cacheWrite, total.output], [115 + 312 + 403, 800, 15, 36]);

  const spans = buildSpans(session, { content: "full", environment: "test" });
  const chats = spans.filter((s) => spanAttr(s, "gen_ai.operation.name") === "chat");
  assert.equal(
    chats.reduce((n, s) => n + Number(spanAttr(s, "gen_ai.usage.input_tokens")), 0),
    total.input,
  );
  // Turn roots carry totals under agent.turn.*, never gen_ai.usage.*, so summing gen_ai.usage.* cannot double count.
  for (const turnRoot of spans.filter((s) => spanAttr(s, "gen_ai.operation.name") === "invoke_agent")) {
    assert.equal(spanAttr(turnRoot, "gen_ai.usage.input_tokens"), undefined);
  }
});

test("messages: each chat span carries only new input, tool results use the tool role", () => {
  const root = freshHome();
  const path = writeJsonl(join(claudeProject(root), `${S}.jsonl`), baseSession());
  const spans = buildSpans(parseClaude(path, { final: true }), { content: "full", environment: "test" });
  const chat = (id: string) => spans.find((s) => spanAttr(s, "gen_ai.response.id") === id)!;
  const inA = JSON.parse(String(spanAttr(chat("msg_A"), "gen_ai.input.messages")));
  assert.deepEqual(
    inA.map((m: any) => m.role),
    ["user"],
  );
  assert.equal(inA[0].id, "u1");
  const inB = JSON.parse(String(spanAttr(chat("msg_B"), "gen_ai.input.messages")));
  assert.deepEqual(
    inB.map((m: any) => m.role),
    ["tool"],
    "msg_B input is only the tool result, not the whole history",
  );
  assert.equal(inB[0].parts[0].type, "tool_call_response");
  const outA = JSON.parse(String(spanAttr(chat("msg_A"), "gen_ai.output.messages")));
  assert.deepEqual(
    outA[0].parts.map((p: any) => p.type),
    ["reasoning", "tool_call"],
  );
  const tool = spans.find((s) => s.name === "execute_tool Read")!;
  assert.equal(spanAttr(tool, "agent.tool.file_path"), "/work/repo/x.ts");
  assert.equal(spanAttr(tool, "agent.tool.result_bytes"), "const x = 1;\n".repeat(50).length);
  assert.equal(tool.parentSpanId, chat("msg_A").parentSpanId, "tools hang off the turn root, like chat spans");
});

test("incremental: sessions build up over time, nothing is ever sent twice", async () => {
  const root = freshHome();
  const path = writeJsonl(join(claudeProject(root), `${S}.jsonl`), baseSession());

  const sink1 = memorySink();
  const r1 = await syncTranscript(path, { sink: sink1 });
  // Turn 1 is complete (stop marker). Turn 2's only call is the last line in the file: not yet known complete.
  assert.deepEqual(names(sent(sink1)), [
    "chat claude-opus-5-5",
    "chat claude-opus-5-5",
    "execute_tool Read",
    "invoke_agent claude-code",
  ]);
  assert.equal(r1.settled, false);

  const sink2 = memorySink();
  const r2 = await syncTranscript(path, { sink: sink2 });
  assert.equal(sent(sink2).length, 0, "re-sync without changes sends nothing");
  assert.equal(r2.alreadySent, r1.sent);

  // A new prompt arrives: turn 2 and its call are now complete.
  appendJsonl(path, [cc.prompt(S, "u3", 120, "thanks")]);
  const sink3 = memorySink();
  await syncTranscript(path, { sink: sink3 });
  assert.deepEqual(names(sent(sink3)), ["chat claude-opus-5-5", "invoke_agent claude-code"]);
  assert.equal(
    spanAttr(
      sent(sink3).find((s) => s.name.startsWith("chat"))!,
      "gen_ai.response.id",
    ),
    "msg_C",
  );

  // Stop hook for turn 3 (no model calls): only its root is new.
  const sink4 = memorySink();
  const r4 = await syncTranscript(path, { sink: sink4, final: true });
  assert.deepEqual(names(sent(sink4)), ["invoke_agent claude-code"]);
  assert.equal(r4.settled, true);

  const all = [...sent(sink1), ...sent(sink3), ...sent(sink4)];
  assert.equal(new Set(all.map((s) => s.spanId)).size, all.length);
  const conv = new Set(all.map((s) => spanAttr(s, "gen_ai.conversation.id")));
  assert.deepEqual([...conv], [S], "every span belongs to one conversation");
  assert.equal(
    new Set(all.filter((s) => s.name.startsWith("invoke_agent")).map((s) => s.traceId)).size,
    3,
    "one trace per turn",
  );
});

test("resume/fork prefix: copied lines keep the parent's sessionId and are not re-sent", async () => {
  const root = freshHome();
  const dir = claudeProject(root);
  const parent = writeJsonl(join(dir, `${S}.jsonl`), baseSession());
  const CHILD = "22222222-2222-4222-8222-222222222222";
  const child = writeJsonl(join(dir, `${CHILD}.jsonl`), [
    ...baseSession(S),
    cc.prompt(CHILD, "c1", 200, "continue"),
    cc.assistant(CHILD, "c2", 202, "msg_D", { type: "text", text: "ok" }, usage(1, 500, 0, 4)),
  ]);

  const session = parseClaude(child, { final: true });
  assert.equal(session.parentSessionId, S);
  assert.deepEqual(
    session.turns.flatMap((t) => t.calls).map((c) => c.id),
    ["msg_D"],
  );

  const sink = memorySink();
  await syncTranscript(parent, { sink, final: true });
  await syncTranscript(child, { sink, final: true });
  const chats = sent(sink).filter((s) => s.name.startsWith("chat"));
  assert.deepEqual(chats.map((s) => spanAttr(s, "gen_ai.response.id")).toSorted(), [
    "msg_A",
    "msg_B",
    "msg_C",
    "msg_D",
  ]);
});

test("rewritten copy: history copied under the new sessionId is caught by the global ledger", async () => {
  const root = freshHome();
  const dir = claudeProject(root);
  const parent = writeJsonl(join(dir, `${S}.jsonl`), baseSession());
  const COPY = "33333333-3333-4333-8333-333333333333";
  const copy = writeJsonl(join(dir, `${COPY}.jsonl`), [
    ...baseSession(COPY),
    cc.prompt(COPY, "k1", 200, "more"),
    cc.assistant(COPY, "k2", 202, "msg_E", { type: "text", text: "ok" }, usage(1, 1, 0, 1)),
  ]);

  const sink = memorySink();
  await syncTranscript(parent, { sink, final: true });
  const before = sent(sink).length;
  await syncTranscript(copy, { sink, final: true });
  const added = sent(sink).slice(before);
  assert.deepEqual(
    added.filter((s) => s.name.startsWith("chat")).map((s) => spanAttr(s, "gen_ai.response.id")),
    ["msg_E"],
  );
  assert.equal(added.filter((s) => s.name.startsWith("execute_tool")).length, 0, "copied tool spans are not re-sent");
});

test("fork subagent: copied parent history (even a mid-stream partial copy) is not double counted", () => {
  const root = freshHome();
  const dir = claudeProject(root);
  const path = writeJsonl(join(dir, `${S}.jsonl`), [
    cc.prompt(S, "u1", 0, "investigate"),
    cc.assistant(
      S,
      "a1",
      2,
      "msg_P",
      { type: "tool_use", id: "toolu_fork", name: "Agent", input: { subagent_type: "fork", prompt: "dig" } },
      usage(5, 1000, 50, 30),
    ),
    cc.toolResult(S, "r1", 40, "toolu_fork", "done", { toolUseResult: { agentId: "f00d", status: "completed" } }),
    cc.assistant(S, "a2", 42, "msg_Q", { type: "text", text: "summary" }, usage(1, 1100, 0, 5)),
    cc.stopMarker(S, "m1", 43),
  ]);
  const subDir = join(dir, S, "subagents");
  mkdirSync(subDir, { recursive: true });
  writeJsonl(join(subDir, "agent-f00d.jsonl"), [
    cc.prompt(S, "f1", 3, "investigate"),
    // Copied parent message, captured while still streaming: smaller output count.
    cc.assistant(
      S,
      "f2",
      3,
      "msg_P",
      { type: "tool_use", id: "toolu_fork", name: "Agent", input: {} },
      usage(5, 1000, 50, 12),
    ),
    cc.toolResult(S, "f3", 3, "toolu_fork", "[fork started]"),
    cc.assistant(S, "f4", 10, "msg_F", { type: "text", text: "found it" }, usage(7, 900, 20, 40)),
  ]);
  writeFileSync(
    join(subDir, "agent-f00d.meta.json"),
    JSON.stringify({ agentType: "fork", isFork: true, toolUseId: "toolu_fork", spawnDepth: 1, finished: true }),
  );

  const session = parseClaude(path, { final: true });
  assert.equal(session.subagents.length, 1);
  assert.deepEqual(
    session.subagents[0]!.calls.map((c) => c.id),
    ["msg_F"],
  );
  assert.equal(session.turns[0]!.calls.find((c) => c.id === "msg_P")!.usage!.output, 30, "parent's final count wins");

  const spans = buildSpans(session, { content: "full", environment: "test" });
  const sub = spans.find((s) => s.name === "invoke_agent fork")!;
  const launcher = spans.find((s) => s.name === "execute_tool Agent")!;
  assert.equal(sub.parentSpanId, launcher.spanId, "subagent nests under the tool call that launched it");
  assert.equal(sub.traceId, launcher.traceId);
  const subChat = spans.find((s) => spanAttr(s, "gen_ai.response.id") === "msg_F")!;
  assert.equal(subChat.parentSpanId, sub.spanId);
  assert.equal(spanAttr(subChat, "gen_ai.conversation.id"), S);
});

test("crash between send and ledger write: at-most-once, never a duplicate", async () => {
  const root = freshHome();
  const path = writeJsonl(join(claudeProject(root), `${S}.jsonl`), baseSession());
  const ids = buildSpans(parseClaude(path, { final: true }), { content: "full", environment: "local" }).map(
    (s) => s.spanId,
  );
  loadSent(); // a worker that already synced other sessions has the ledger cached in memory
  // Simulate: batch was in flight when the process died.
  writePending(`claude-code:${S}`, ids.slice(0, 2));
  const sink = memorySink();
  await syncTranscript(path, { sink, final: true });
  const sentIds = sent(sink).map((s) => s.spanId);
  assert.ok(!sentIds.includes(ids[0]!) && !sentIds.includes(ids[1]!), "possibly-delivered spans are not re-sent");
  assert.equal(sentIds.length, ids.length - 2);
  assert.equal(recoverPending(), 0, "pending batch was consumed");
});

test("retryable failure: nothing is marked sent, next sync delivers everything", async () => {
  const root = freshHome();
  const path = writeJsonl(join(claudeProject(root), `${S}.jsonl`), baseSession());
  const failing = memorySink();
  failing.fail = { ok: false, retryable: true, status: 429, message: "rate limited" };
  const r1 = await syncTranscript(path, { sink: failing, final: true });
  assert.ok(r1.failed > 0);
  assert.equal(loadSent().size, 0);
  const ok = memorySink();
  const r2 = await syncTranscript(path, { sink: ok, final: true });
  assert.equal(r2.sent, r2.built);
});

test("poison span: a permanently rejected span is isolated and skipped, the rest is delivered", async () => {
  const root = freshHome();
  const path = writeJsonl(join(claudeProject(root), `${S}.jsonl`), baseSession());
  const delivered: OtlpSpan[] = [];
  const sink = {
    name: "picky",
    async send(spans: OtlpSpan[]) {
      if (spans.some((s) => s.name === "execute_tool Read"))
        return { ok: false as const, retryable: false, status: 400, message: "bad span" };
      delivered.push(...spans);
      return { ok: true as const };
    },
  };
  const r = await syncTranscript(path, { sink, final: true });
  assert.equal(r.poisoned, 1);
  assert.equal(delivered.length, r.built - 1);
  const again = await syncTranscript(path, { sink, final: true });
  assert.equal(again.sent, 0, "poisoned span is not retried forever");
});

test("synthetic messages and API errors are not model calls", () => {
  const root = freshHome();
  const path = writeJsonl(join(claudeProject(root), `${S}.jsonl`), [
    cc.prompt(S, "u1", 0, "hi"),
    { type: "system", subtype: "api_error", sessionId: S, uuid: "e1", timestamp: "2026-11-01T10:00:01.000Z" },
    cc.assistant(S, "a1", 2, "msg_syn", { type: "text", text: "API Error" }, usage(0, 0, 0, 0), "<synthetic>"),
  ]);
  const session = parseClaude(path, { final: true });
  assert.equal(session.turns[0]!.calls.length, 0);
  assert.equal(session.turns[0]!.apiErrors, 1);
  assert.equal(session.diagnostics.syntheticMessages, 1);
});

test("forked session: a copied subagents/ directory stays with the original session", () => {
  const root = freshHome();
  const dir = claudeProject(root);
  const FORK = "44444444-4444-4444-8444-444444444444";
  const path = writeJsonl(join(dir, `${FORK}.jsonl`), [
    ...baseSession(S),
    cc.prompt(FORK, "f1", 300, "carry on"),
    cc.assistant(FORK, "f2", 302, "msg_G", { type: "text", text: "ok" }, usage(1, 10, 0, 1)),
  ]);
  const subDir = join(dir, FORK, "subagents");
  mkdirSync(subDir, { recursive: true });
  // Copied from the original session: lines keep sessionId S, and the copy has no meta file.
  writeJsonl(join(subDir, "agent-c0de.jsonl"), [
    cc.prompt(S, "s1", 5, "dig"),
    cc.assistant(S, "s2", 6, "msg_SUB", { type: "text", text: "found" }, usage(5, 500, 50, 20)),
  ]);
  const session = parseClaude(path, { final: true });
  assert.deepEqual(session.subagents, [], "the original session owns (and sends) that subagent");
  assert.deepEqual(
    session.turns.flatMap((t) => t.calls).map((c) => c.id),
    ["msg_G"],
  );
});

test("idle compaction stamped before the previous call is still a compaction, not a cache break", () => {
  const root = freshHome();
  const path = writeJsonl(join(claudeProject(root), `${S}.jsonl`), [
    cc.prompt(S, "u1", 0, "work"),
    cc.assistant(S, "a1", 10, "msg_1", { type: "text", text: "done" }, usage(1, 370_000, 2000, 50)),
    // Precomputed summary: its boundary is stamped earlier than msg_1 but written after it.
    {
      type: "system",
      subtype: "compact_boundary",
      sessionId: S,
      uuid: "cb",
      timestamp: "2026-11-01T10:00:05.000Z",
      compactMetadata: { trigger: "auto", preTokens: 372_000, postTokens: 30_000, durationMs: 0, precomputed: true },
    },
    cc.prompt(S, "u2", 3300, "back"),
    cc.assistant(S, "a2", 3310, "msg_2", { type: "text", text: "ok" }, usage(1, 55_000, 48_000, 40)),
  ]);
  const call = parseClaude(path, { final: true }).turns[1]!.calls[0]!;
  assert.equal(call.analysis!.compactedBefore, true);
  assert.equal(call.analysis!.cacheBreak, false);
});

test("call timing: injected records count as activity, implausible waits are clamped, empty thinking is dropped", () => {
  const root = freshHome();
  const path = writeJsonl(join(claudeProject(root), `${S}.jsonl`), [
    cc.prompt(S, "u1", 0, "start"),
    // Delivered hours later as an injected command, not as a user record.
    {
      type: "attachment",
      sessionId: S,
      uuid: "q1",
      timestamp: "2026-11-01T22:00:00.000Z",
      attachment: { type: "queued_command", prompt: "<task-notification>done</task-notification>" },
    },
    cc.assistant(S, "a1", 12 * 3600 + 8, "msg_1", { type: "thinking", thinking: "" }, usage(1, 100, 0, 10)),
    cc.assistant(S, "a2", 12 * 3600 + 9, "msg_1", { type: "text", text: "ok" }, usage(1, 100, 0, 10)),
    cc.prompt(S, "u2", 13 * 3600, "next"),
    // Nothing recorded for two hours between this prompt and the response.
    cc.assistant(S, "a3", 15 * 3600, "msg_2", { type: "text", text: "late" }, usage(1, 100, 0, 10)),
  ]);
  const calls = parseClaude(path, { final: true }).turns.flatMap((t) => t.calls);
  assert.equal((calls[0]!.end - calls[0]!.start) / 1000, 9, "starts at the injected command, not the morning prompt");
  assert.equal(calls[1]!.start, calls[1]!.end, "a 2h gap is not a 2h model call");
  assert.deepEqual(
    calls[0]!.output[0]!.parts.map((p) => p.type),
    ["text"],
  );
});
