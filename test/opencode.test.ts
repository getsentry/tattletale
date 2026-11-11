// OpenCode: sessions are read from a SQLite database laid out like OpenCode 1.19's (the tables and JSON shapes
// below are copied from a real session), snapshotted, parsed and sent.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listOpencodeSessions, opencodeSnapshot, parseOpencode } from "../src/opencode.ts";
import { opencodePluginSource } from "../src/opencode-plugin.ts";
import { memorySink } from "../src/send.ts";
import { buildSpans, spanAttr } from "../src/spans.ts";
import { enqueue, home, takeJobs } from "../src/state.ts";
import { runWorker, syncTranscript } from "../src/sync.ts";
import { verifyTranscript } from "../src/verify.ts";
import { freshHome } from "./helpers.ts";

const { DatabaseSync: Db } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
const T = Date.parse("2026-11-01T10:00:00Z");
const ROOT = "ses_root0000000000000000001";
const CHILD = "ses_child000000000000000001";

function createDb(root: string): DatabaseSync {
  process.env.XDG_DATA_HOME = join(root, "data");
  spawnSync("mkdir", ["-p", join(root, "data", "opencode")]);
  const db = new Db(join(root, "data", "opencode", "opencode.db"));
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL,
      directory text NOT NULL, title text NOT NULL, version text NOT NULL, tokens_input integer DEFAULT 0 NOT NULL,
      tokens_output integer DEFAULT 0 NOT NULL, tokens_reasoning integer DEFAULT 0 NOT NULL,
      tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL, cost real,
      agent text, time_created integer NOT NULL, time_updated integer NOT NULL);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL,
      time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);`);
  return db;
}

const tokens = (input: number, output: number, reasoning: number, read: number, write: number) => ({
  total: input + output + reasoning + read + write,
  input,
  output,
  reasoning,
  cache: { read, write },
});

/** Builds sessions the way OpenCode writes them: messages, parts, and the session's running totals. */
function writer(db: DatabaseSync) {
  let seq = 0;
  const id = (prefix: string) => `${prefix}_${String(++seq).padStart(6, "0")}aaaaaaaaaaaaaaaa`;
  const session = (sid: string, parent: string | null, title: string) =>
    db
      .prepare(
        "INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'p', ?, 's', '/work/proj', ?, '1.19.5', ?, ?)",
      )
      .run(sid, parent, title, T, T);
  const touch = (sid: string, at: number) =>
    db.prepare("UPDATE session SET time_updated = ? WHERE id = ?").run(at, sid);
  const message = (sid: string, data: any, at: number) => {
    const mid = id("msg");
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(mid, sid, at, at, JSON.stringify(data));
    touch(sid, at);
    return mid;
  };
  const part = (sid: string, mid: string, data: any, at: number) => {
    const pid = id("prt");
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(pid, mid, sid, at, at, JSON.stringify(data));
    touch(sid, at);
    return pid;
  };
  const addTotals = (sid: string, t: ReturnType<typeof tokens>) =>
    db
      .prepare(
        "UPDATE session SET tokens_input = tokens_input + ?, tokens_output = tokens_output + ?, tokens_reasoning = tokens_reasoning + ?, tokens_cache_read = tokens_cache_read + ?, tokens_cache_write = tokens_cache_write + ? WHERE id = ?",
      )
      .run(t.input, t.output, t.reasoning, t.cache.read, t.cache.write, sid);
  const user = (sid: string, at: number, text: string, extra: any[] = []) => {
    const mid = message(sid, { role: "user", time: { created: at }, agent: "build" }, at);
    part(sid, mid, { type: "text", text }, at);
    for (const p of extra) part(sid, mid, p, at);
    return mid;
  };
  /** One assistant message = one request: step-start, its parts, step-finish with the usage. */
  const step = (
    sid: string,
    parent: string,
    at: number,
    t: ReturnType<typeof tokens>,
    parts: any[],
    finish: string,
  ) => {
    const info = {
      role: "assistant",
      parentID: parent,
      modelID: "anthropic/claude-haiku-5.5",
      providerID: "openrouter",
    };
    const mid = message(sid, { ...info, time: { created: at } }, at);
    part(sid, mid, { type: "step-start" }, at);
    for (const p of parts) part(sid, mid, p, at + 500);
    part(sid, mid, { type: "step-finish", reason: finish, tokens: t }, at + 900);
    part(sid, mid, { type: "patch", hash: "abc", files: [] }, at + 900);
    db.prepare("UPDATE message SET data = ? WHERE id = ?").run(
      JSON.stringify({ ...info, time: { created: at, completed: at + 900 }, tokens: t, finish }),
      mid,
    );
    addTotals(sid, t);
  };
  return { session, user, step, message };
}

const tool = (callID: string, name: string, input: any, state: any) => ({
  type: "tool",
  tool: name,
  callID,
  state: { input, time: { start: T, end: T }, ...state },
});
const image = `data:image/png;base64,${"A".repeat(200_000)}`;

/** Turn 1: read + failing bash. Turn 2: a subagent (child session) reads a file. */
function seed(db: DatabaseSync) {
  const w = writer(db);
  w.session(ROOT, null, "fix calc");
  const u1 = w.user(ROOT, T + 1000, "fix calc.py", [{ type: "file", mime: "image/png", url: image }]);
  w.step(
    ROOT,
    u1,
    T + 2000,
    tokens(4, 56, 0, 0, 10516),
    [
      { type: "reasoning", text: "" },
      tool("toolu_read", "read", { filePath: "/work/proj/calc.py" }, { status: "completed", output: "def add" }),
      tool(
        "toolu_ls",
        "bash",
        { command: "ls nope" },
        { status: "completed", output: "no such file", metadata: { exit: 2 } },
      ),
    ],
    "tool-calls",
  );
  w.step(
    ROOT,
    u1,
    T + 3000,
    tokens(2, 202, 45, 10516, 126),
    [tool("toolu_bash", "bash", { command: "cat nope" }, { status: "error", error: "exit 1: no such file" })],
    "tool-calls",
  );
  w.step(ROOT, u1, T + 4000, tokens(2, 77, 0, 10642, 267), [{ type: "text", text: "fixed it" }], "stop");

  const u2 = w.user(ROOT, T + 60_000, "use a subagent to read other.py");
  w.step(
    ROOT,
    u2,
    T + 61_000,
    tokens(4, 153, 0, 10909, 168),
    [
      tool(
        "toolu_task",
        "task",
        { description: "Read other.py", prompt: "read it", subagent_type: "general" },
        { status: "completed", output: "x = 1", metadata: { sessionId: CHILD } },
      ),
    ],
    "tool-calls",
  );
  w.session(CHILD, ROOT, "Read other.py (@general subagent)");
  const cu = w.user(CHILD, T + 61_100, "read it");
  w.step(
    CHILD,
    cu,
    T + 61_200,
    tokens(4, 55, 0, 0, 8306),
    [tool("toolu_child_read", "read", { filePath: "/work/proj/other.py" }, { status: "completed", output: "x = 1" })],
    "tool-calls",
  );
  w.step(CHILD, cu, T + 62_000, tokens(2, 57, 0, 8306, 113), [{ type: "text", text: "x = 1" }], "stop");
  w.step(ROOT, u2, T + 63_000, tokens(2, 47, 0, 11077, 264), [{ type: "text", text: "it says x = 1" }], "stop");
  return w;
}

test("opencode: calls, tokens, tools and the subagent come out of the database right", () => {
  const db = createDb(freshHome());
  seed(db);
  const path = opencodeSnapshot(CHILD); // a subagent's ID resolves to its root session
  assert.equal(path, join(home(), "opencode", `${ROOT}.json`));
  assert.ok(!readFileSync(path!, "utf8").includes("AAAAAAAAAA"), "image data is not copied");

  const s = parseOpencode(path!, { final: true });
  assert.equal(s.agent, "opencode");
  assert.equal(s.sessionId, ROOT);
  assert.equal(s.cwd, "/work/proj");
  assert.equal(s.turns.length, 2);
  const [t1, t2] = s.turns;
  assert.equal(t1!.calls.length, 3, "one call per step; the trailing patch part is not a call");
  // Sentry's convention: input includes cache reads and writes, output includes reasoning.
  assert.deepEqual(
    t1!.calls.map((c) => [c.usage!.input, c.usage!.cacheRead, c.usage!.cacheWrite, c.usage!.output]),
    [
      [10520, 0, 10516, 56],
      [10644, 10516, 126, 247],
      [10911, 10642, 267, 77],
    ],
  );
  assert.deepEqual(t1!.calls[0]!.input[0]!.parts, [
    { type: "text", content: "fix calc.py" },
    { type: "blob", mime_type: "image/png" },
  ]);
  assert.equal(t1!.calls[1]!.input[0]!.role, "tool", "the next call's input is the previous call's tool results");
  assert.deepEqual(
    t1!.tools.map((t) => [t.name, t.isError ?? false, t.result]),
    [
      ["read", false, "def add"],
      ["bash", true, "no such file"],
      ["bash", true, "exit 1: no such file"],
    ],
  );
  assert.equal(s.subagents.length, 1);
  const sub = s.subagents[0]!;
  assert.deepEqual(
    [sub.agentId, sub.agentType, sub.description, sub.parentToolId],
    [CHILD, "general", "Read other.py", "toolu_task"],
  );
  assert.equal(sub.calls.length, 2);
  assert.equal(t2!.calls.length, 2);

  const v = verifyTranscript(path!, "opencode");
  assert.ok(v.ok, JSON.stringify(v.checks.filter((c) => !c.ok)));
  assert.ok(v.checks.some((c) => c.name.includes("OpenCode's own session totals") && c.ok));

  const spans = buildSpans(s, { content: "full", environment: "test" });
  const read = spans.find((x) => spanAttr(x, "gen_ai.tool.name") === "read")!;
  assert.equal(spanAttr(read, "agent.tool.file_path"), "/work/proj/calc.py");
  assert.equal(spanAttr(spans[0]!, "sentry.release"), "opencode@1.19.5");
  const subRoot = spans.find((x) => spanAttr(x, "agent.subagent.id") === CHILD)!;
  assert.equal(spanAttr(subRoot, "gen_ai.agent.name"), "general");
  const subChats = spans.filter(
    (x) => x.parentSpanId === subRoot.spanId && spanAttr(x, "gen_ai.operation.name") === "chat",
  );
  assert.equal(subChats.length, 2, "subagent calls hang under the subagent");
  assert.equal(spanAttr(subChats[0]!, "gen_ai.conversation.id"), ROOT, "in the session's conversation");
  const task = spans.find((x) => spanAttr(x, "gen_ai.tool.call.id") === "toolu_task")!;
  assert.equal(subRoot.parentSpanId, task.spanId, "under the task tool call that started it");
});

test("opencode: a session growing turn by turn is sent once, new turns only", async () => {
  const db = createDb(freshHome());
  const w = writer(db);
  w.session(ROOT, null, "grow");
  const u1 = w.user(ROOT, T + 1000, "one");
  w.step(ROOT, u1, T + 2000, tokens(4, 10, 0, 0, 1000), [{ type: "text", text: "a" }], "stop");
  const sink = memorySink();
  const first = await syncTranscript(listOpencodeSessions(0)[0]!, { sink });
  assert.equal(first.sent, first.built);
  assert.equal(first.built, 2, "turn root + chat");

  const u2 = w.user(ROOT, T + 60_000, "two");
  w.step(ROOT, u2, T + 61_000, tokens(2, 12, 0, 1000, 20), [{ type: "text", text: "b" }], "stop");
  const [path] = listOpencodeSessions(0);
  const second = await syncTranscript(path!, { sink });
  assert.deepEqual([second.built, second.alreadySent, second.sent], [4, 2, 2]);
  const again = await syncTranscript(listOpencodeSessions(0)[0]!, { sink });
  assert.equal(again.sent, 0);
});

test("opencode: unchanged sessions are not rewritten; the snapshot carries the session's last activity time", () => {
  const db = createDb(freshHome());
  seed(db);
  const path = opencodeSnapshot(ROOT)!;
  const stamp = (db.prepare("SELECT max(time_updated) AS u FROM part").get() as any).u;
  assert.equal(Math.round(statSync(path).mtimeMs), stamp);
  writeFileSync(path, readFileSync(path, "utf8").replace("fixed it", "MARK"));
  utimesSync(path, new Date(stamp), new Date(stamp));
  opencodeSnapshot(ROOT);
  assert.ok(readFileSync(path, "utf8").includes("MARK"), "same update time: left alone");
});

test("opencode: the plugin wakes the hook, and the worker syncs the root session", async () => {
  const root = freshHome();
  const db = createDb(root);
  seed(db);
  // A stand-in for hooks/run.sh that records what the plugin hands it.
  const runSh = join(root, "run.sh");
  const got = join(root, "got.json");
  writeFileSync(runSh, `cat > ${got}\n`);
  chmodSync(runSh, 0o755);
  const pluginFile = join(root, "tattletale.js");
  writeFileSync(pluginFile, opencodePluginSource(runSh));
  const { Tattletale } = await import(pathToFileURL(pluginFile).href);
  const hooks = await Tattletale({});
  await hooks.event({ event: { type: "message.updated", properties: { sessionID: ROOT } } });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: CHILD } } });
  for (let i = 0; i < 50 && !existsSync(got); i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(JSON.parse(readFileSync(got, "utf8")), {
    hook_event_name: "Stop",
    session_id: CHILD,
    agent: "opencode",
  });

  // What the hook then queues: a subagent's idle refreshes the root session without ending its turn.
  enqueue({ agent: "opencode", event: "Stop", sessionId: CHILD, at: T });
  const jobs = takeJobs();
  assert.equal(jobs.length, 1);
  enqueue(jobs[0]!);
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  process.env.CODEX_HOME = join(root, "codex");
  await runWorker(0);
  const marks = JSON.parse(readFileSync(join(home(), "files.json"), "utf8"));
  assert.ok(marks[join(home(), "opencode", `${ROOT}.json`)], "the root session was synced");
});

test("opencode: install writes the plugin under the OpenCode config folder; uninstall removes it", () => {
  const root = freshHome();
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const env = { ...process.env, XDG_CONFIG_HOME: join(root, "config"), PATH: "/usr/bin:/bin" };
  const plugin = join(root, "config", "opencode", "plugins", "tattletale.js");
  const install = spawnSync(process.execPath, ["--no-warnings", cli, "install", "--opencode"], {
    env,
    encoding: "utf8",
  });
  assert.equal(install.status, 0, install.stderr);
  assert.ok(readFileSync(plugin, "utf8").includes("hooks/run.sh"));
  const uninstall = spawnSync(process.execPath, ["--no-warnings", cli, "uninstall"], { env, encoding: "utf8" });
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.ok(!existsSync(plugin));
});

test("opencode: a request still streaming is not sent, so it can't come back later under another ID", async () => {
  const db = createDb(freshHome());
  const w = writer(db);
  w.session(ROOT, null, "stream");
  const u1 = w.user(ROOT, T + 1000, "go");
  w.step(
    ROOT,
    u1,
    T + 2000,
    tokens(4, 10, 0, 0, 1000),
    [tool("toolu_1", "bash", { command: "ls" }, { status: "completed", output: "a" })],
    "tool-calls",
  );
  // OpenCode writes the next message as soon as the request starts: zero tokens, no step-finish yet.
  const streaming = {
    role: "assistant",
    parentID: u1,
    modelID: "m",
    providerID: "p",
    time: { created: T + 3000 },
    tokens: tokens(0, 0, 0, 0, 0),
  };
  const mid = w.message(ROOT, streaming, T + 3000);
  db.prepare("INSERT INTO part VALUES ('prt_zz1', ?, ?, ?, ?, ?)").run(
    mid,
    ROOT,
    T + 3000,
    T + 3000,
    JSON.stringify({ type: "step-start" }),
  );
  db.prepare("INSERT INTO part VALUES ('prt_zz2', ?, ?, ?, ?, ?)").run(
    mid,
    ROOT,
    T + 3100,
    T + 3100,
    JSON.stringify({ type: "text", text: "partial" }),
  );
  const sink = memorySink();
  const sent = () => sink.batches.flat().map((s) => s.spanId);
  await syncTranscript(opencodeSnapshot(ROOT)!, { sink, now: T + 3200 });

  // The request finishes.
  db.prepare("INSERT INTO part VALUES ('prt_zz3', ?, ?, ?, ?, ?)").run(
    mid,
    ROOT,
    T + 3900,
    T + 3900,
    JSON.stringify({ type: "step-finish", reason: "stop", tokens: tokens(2, 12, 0, 1000, 20) }),
  );
  db.prepare("UPDATE session SET time_updated = ? WHERE id = ?").run(T + 3900, ROOT);
  const path = opencodeSnapshot(ROOT)!;
  await syncTranscript(path, { sink, final: true });
  const built = buildSpans(parseOpencode(path, { final: true }), { content: "full", environment: "test" }).map(
    (s) => s.spanId,
  );
  assert.deepEqual(sent().toSorted(), built.toSorted(), "every span sent is in the final session, each once");
});
