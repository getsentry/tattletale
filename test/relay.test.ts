import assert from "node:assert/strict";
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createRelay } from "../src/relay.ts";
import { memorySink } from "../src/send.ts";
import { spanAttr } from "../src/spans.ts";
import { loadConfig, loadOtelSessions, markOtelSession } from "../src/state.ts";
import { syncTranscript } from "../src/sync.ts";
import { cc, claudeProject, freshHome, usage, writeJsonl } from "./helpers.ts";

const s = (v: string) => ({ stringValue: v });
const i = (v: number) => ({ intValue: String(v) });
const T0 = Date.parse("2026-11-05T10:00:00Z");
const span = (id: string, parent: string, name: string, at: number, a: Record<string, any>) => ({
  traceId: "a".repeat(32),
  spanId: id,
  parentSpanId: parent,
  name,
  kind: 1,
  startTimeUnixNano: String(BigInt(at) * 1_000_000n),
  endTimeUnixNano: String(BigInt(at + 100) * 1_000_000n),
  attributes: Object.entries({ "session.id": s("sess-1"), "gen_ai.conversation.id": s("sess-1"), ...a }).map(
    ([key, value]) => ({ key, value }),
  ),
  status: { code: 0 },
});
const traces = () => ({
  resourceSpans: [
    {
      scopeSpans: [
        {
          spans: [
            span("root", "", "claude_code.interaction", T0, {
              "gen_ai.operation.name": s("invoke_agent"),
              user_prompt: s("hi"),
            }),
            span("llm1", "root", "claude_code.llm_request", T0 + 10, {
              model: s("claude-haiku-5-5"),
              request_id: s("req_1"),
              input_tokens: i(1),
              cache_read_tokens: i(10),
              cache_creation_tokens: i(5),
              output_tokens: i(3),
            }),
          ],
        },
      ],
    },
  ],
});
const logs = {
  resourceLogs: [
    {
      scopeLogs: [
        {
          logRecords: [
            {
              attributes: [
                { key: "event.name", value: s("assistant_response") },
                { key: "request_id", value: s("req_1") },
                { key: "response", value: s("hello") },
              ],
            },
          ],
        },
      ],
    },
  ],
};

function setup() {
  const root = freshHome();
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  const dir = claudeProject(root);
  return { root, dir };
}

test("relay: holds a trace until it is quiet, maps it with its logs, never re-sends", async () => {
  const { dir } = setup();
  writeJsonl(join(dir, "sess-1.jsonl"), [cc.prompt("sess-1", "u1", 0, "hi")]);
  let t = T0 + 1000;
  const sink = memorySink();
  const relay = createRelay({ sink, config: loadConfig(), now: () => t });
  relay.receive("/v1/traces", traces());
  relay.receive("/v1/logs", logs);
  assert.equal((await relay.flush()).sent, 0, "not yet quiet");
  t += 6000;
  const r = await relay.flush();
  assert.equal(r.sent, 2);
  const chat = sink.batches.flat().find((x) => x.name.startsWith("chat"))!;
  assert.equal(spanAttr(chat, "gen_ai.usage.input_tokens"), 16);
  assert.match(String(spanAttr(chat, "gen_ai.output.messages")), /hello/);
  assert.equal(spanAttr(chat, "agent.session.cwd"), "/work/repo", "cwd recovered from the local transcript");
  assert.equal(spanAttr(chat, "agent.source"), "otel");
  assert.equal(loadOtelSessions().get("sess-1"), T0, "session recorded with its first span time");

  relay.receive("/v1/traces", traces()); // exporter retry of the same batch
  t += 6000;
  assert.equal((await relay.flush()).sent, 0, "ledger stops duplicates");
});

test("relay: include/ignore apply to OTel too", async () => {
  const { dir } = setup();
  writeJsonl(join(dir, "sess-1.jsonl"), [cc.prompt("sess-1", "u1", 0, "hi")]);
  const sink = memorySink();
  const relay = createRelay({
    sink,
    config: { ...loadConfig(), include: ["/somewhere/else"] },
    now: () => T0 + 60_000,
  });
  relay.receive("/v1/traces", traces());
  const r = await relay.flush(true);
  assert.equal(r.sent, 0);
  assert.equal(r.skipped, 2);
});

test("ownership: transcript keeps pre-OTel turns, waits for unseen sessions, falls back once idle", async () => {
  const { dir } = setup();
  const S = "sess-2";
  const path = writeJsonl(join(dir, `${S}.jsonl`), [
    cc.prompt(S, "u1", 0, "before"),
    cc.assistant(S, "a1", 2, "msg_old", { type: "text", text: "ok" }, usage(1, 10, 0, 1)),
    cc.prompt(S, "u2", 3600, "after"),
    cc.assistant(S, "a2", 3602, "msg_new", { type: "text", text: "ok" }, usage(1, 10, 0, 1)),
  ]);
  const base = { ...loadConfig(), claudeSource: "otel" as const, otelSince: Date.parse("2026-11-01T10:30:00Z") };
  const seenAt = Date.parse("2026-11-01T11:00:00Z"); // between the two turns

  // Relay never saw it, file touched after the switch and still fresh: wait.
  utimesSync(path, new Date(seenAt + 5000), new Date(seenAt + 5000));
  const waiting = await syncTranscript(path, { sink: memorySink(), config: base, final: true, now: seenAt + 60_000 });
  assert.equal(waiting.skipped, "waiting for OTel relay");

  // Relay saw it from the second turn on: transcript sends only the first turn.
  markOtelSession(S, seenAt);
  const sink = memorySink();
  await syncTranscript(path, { sink, config: base, final: true, now: seenAt + 60_000 });
  const ids = sink.batches
    .flat()
    .filter((x) => x.name.startsWith("chat"))
    .map((x) => spanAttr(x, "gen_ai.response.id"));
  assert.deepEqual(ids, ["msg_old"]);
});

test("ownership: the turn whose prompt is stamped just before the first OTel span belongs to OTel", async () => {
  const { dir } = setup();
  const S = "sess-4";
  const path = writeJsonl(join(dir, `${S}.jsonl`), [
    cc.prompt(S, "u1", 0, "hi"),
    cc.assistant(S, "a1", 2, "msg_y", { type: "text", text: "ok" }, usage(1, 1, 0, 1)),
  ]);
  markOtelSession(S, Date.parse("2026-11-01T10:00:00.050Z")); // OTel turn span starts 50ms after the prompt record
  const sink = memorySink();
  const r = await syncTranscript(path, {
    sink,
    config: { ...loadConfig(), claudeSource: "otel", otelSince: 0 },
    final: true,
  });
  assert.equal(r.built, 0);
  assert.equal(sink.batches.flat().length, 0, "nothing from the transcript, so no double");
});

test("ownership: an unseen session falls back to the transcript after 30 idle minutes", async () => {
  const { dir } = setup();
  const S = "sess-3";
  const path = writeJsonl(join(dir, `${S}.jsonl`), [
    cc.prompt(S, "u1", 0, "hi"),
    cc.assistant(S, "a1", 2, "msg_x", { type: "text", text: "ok" }, usage(1, 1, 0, 1)),
  ]);
  const mtime = Date.parse("2026-11-01T12:00:00Z");
  utimesSync(path, new Date(mtime), new Date(mtime));
  const config = { ...loadConfig(), claudeSource: "otel" as const, otelSince: mtime - 3600_000 };
  const sink = memorySink();
  const r = await syncTranscript(path, { sink, config, final: true, now: mtime + 31 * 60_000 });
  assert.equal(r.skipped, undefined);
  assert.ok(sink.batches.flat().some((x) => spanAttr(x, "gen_ai.response.id") === "msg_x"));
});

test("settings env: preserves other keys, refuses to override existing OTel config, removes only its own", async () => {
  const { root } = setup();
  const { applyOtelEnv, otelEnv, removeOtelEnv } = await import("../src/claude-settings.ts");
  const { readFileSync, writeFileSync } = await import("node:fs");
  const path = join(root, "settings.json");
  const env = otelEnv({ relayPort: 43181, content: "full" });

  writeFileSync(
    path,
    JSON.stringify({ model: "opus", env: { FOO: "1", OTEL_EXPORTER_OTLP_ENDPOINT: "https://my-collector" } }),
  );
  const blocked = applyOtelEnv(path, env, { write: true });
  assert.deepEqual(
    blocked.conflicts.map((c) => c.key),
    ["OTEL_EXPORTER_OTLP_ENDPOINT"],
  );
  assert.equal(
    JSON.parse(readFileSync(path, "utf8")).env.OTEL_EXPORTER_OTLP_ENDPOINT,
    "https://my-collector",
    "nothing written",
  );

  writeFileSync(path, JSON.stringify({ model: "opus", env: { FOO: "1" } }));
  applyOtelEnv(path, env, { write: true });
  const written = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(written.model, "opus");
  assert.equal(written.env.FOO, "1");
  assert.equal(written.env.OTEL_EXPORTER_OTLP_ENDPOINT, "http://127.0.0.1:43181");
  assert.equal(written.env.OTEL_EXPORTER_OTLP_PROTOCOL, "http/json");

  removeOtelEnv(path, env, true);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).env, { FOO: "1" });
});
