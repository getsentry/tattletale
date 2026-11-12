// Pi: sessions are JSONL files shaped like Pi 1.5 writes them (header, tree of entries; fields copied from real
// sessions), parsed, verified and sent.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listPiSessions, parsePi } from "../src/pi.ts";
import { piExtensionSource } from "../src/pi-extension.ts";
import { memorySink } from "../src/send.ts";
import { buildSpans, spanAttr } from "../src/spans.ts";
import { home } from "../src/state.ts";
import { detectAgent, runWorker, syncTranscript } from "../src/sync.ts";
import { verifyTranscript } from "../src/verify.ts";
import { freshHome } from "./helpers.ts";

const T = Date.parse("2026-11-01T10:00:00Z");
const iso = (s: number) => new Date(T + s * 1000).toISOString();
const SID = "019e136c-cb55-75ae-8447-726518b76038";
const FORK = "019e2000-0000-7000-8000-000000000001";

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, reasoning?: number) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  ...(reasoning !== undefined && { reasoning }),
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** Entries the way Pi's session manager appends them: each new entry's parent is the previous one, unless given. */
function writer(sessionId: string, cwd = "/work/proj") {
  const lines: any[] = [{ type: "session", version: 3, id: sessionId, timestamp: iso(0), cwd }];
  let seq = 0;
  let leaf: string | null = null;
  const add = (t: number, entry: any, parentId: string | null = leaf) => {
    const id = (++seq).toString(16).padStart(8, "0");
    lines.push({ ...entry, id, parentId, timestamp: iso(t) });
    leaf = id;
    return id;
  };
  return {
    lines,
    add,
    user: (t: number, text: string, parentId?: string | null) =>
      add(t, { type: "message", message: { role: "user", content: text, timestamp: T + t * 1000 } }, parentId),
    assistant: (start: number, end: number, content: any[], stopReason: string, u: any, extra: any = {}) =>
      add(end, {
        type: "message",
        message: {
          role: "assistant",
          content,
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-5",
          usage: u,
          stopReason,
          timestamp: T + start * 1000,
          ...extra,
        },
      }),
    toolResult: (t: number, toolCallId: string, toolName: string, text: string, isError = false, u?: any) =>
      add(t, {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId,
          toolName,
          content: [{ type: "text", text }],
          isError,
          ...(u && { usage: u }),
          timestamp: T + t * 1000,
        },
      }),
    write(dir: string) {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${iso(0).replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
      writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      return path;
    },
  };
}

function seed() {
  const w = writer(SID);
  w.add(0, { type: "thinking_level_change", thinkingLevel: "medium" });
  w.add(1, { type: "model_change", provider: "anthropic", modelId: "claude-sonnet-5" });
  w.user(2, "fix calc.py");
  w.assistant(
    2,
    5,
    [
      { type: "thinking", thinking: "look first", thinkingSignature: "sig" },
      { type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "calc.py" } },
    ],
    "toolUse",
    usage(6, 40, 0, 7738, 12),
    { responseId: "msg_1" },
  );
  w.toolResult(6, "toolu_1", "read", "def add");
  w.assistant(
    6,
    9,
    [{ type: "toolCall", id: "toolu_2", name: "bash", arguments: { command: "python calc.py" } }],
    "toolUse",
    usage(6, 30, 7738, 56),
  );
  w.toolResult(10, "toolu_2", "bash", "Traceback\n\nCommand exited with code 1", true);
  w.assistant(10, 11, [], "error", usage(0, 0, 0, 0), { errorMessage: "overloaded" });
  w.assistant(12, 14, [{ type: "text", text: "fixed it" }], "stop", usage(6, 20, 7794, 90));
  w.add(20, {
    type: "usage",
    kind: "cache_warm",
    provider: "anthropic",
    model: "claude-sonnet-5",
    usage: usage(0, 0, 7884, 0),
  });
  const prompt2 = w.user(60, "now tests");
  w.assistant(
    60,
    70,
    [{ type: "toolCall", id: "toolu_3", name: "codemode", arguments: { code: "classify()" } }],
    "toolUse",
    usage(6, 50, 7884, 30),
  );
  w.toolResult(75, "toolu_3", "codemode", "classified", false, usage(500, 10, 0, 0));
  w.add(80, {
    type: "compaction",
    summary: "User fixed calc.py; now on tests.",
    firstKeptEntryId: prompt2,
    tokensBefore: 9000,
    usage: usage(9000, 300, 0, 0),
  });
  w.assistant(80, 85, [{ type: "text", text: "tests pass" }], "stop", usage(400, 15, 0, 400));
  // /tree back to the first prompt, with a summary of the branch left behind, and a new prompt there.
  const branch = w.add(
    90,
    { type: "branch_summary", fromId: "x", summary: "Tried tests.", usage: usage(800, 40, 0, 0) },
    "00000003",
  );
  w.user(91, "try another way", branch);
  w.assistant(91, 95, [{ type: "text", text: "other way" }], "stop", usage(10, 5, 0, 0));
  return w;
}

test("pi: calls, tokens, tools, side requests and branches come out of the session file right", () => {
  const root = freshHome();
  const path = seed().write(join(root, "sessions", "--work-proj--"));
  assert.equal(detectAgent(path), "pi");
  const s = parsePi(path, { final: true });
  assert.deepEqual([s.agent, s.sessionId, s.cwd], ["pi", SID, "/work/proj"]);
  assert.deepEqual(
    s.turns.map((t) => [t.trigger, t.prompt, t.calls.length, t.complete]),
    [
      ["user", "fix calc.py", 4, true],
      ["user", "now tests", 5, true],
      ["user", "try another way", 1, true],
    ],
  );
  const [t1, t2, t3] = s.turns;
  // Sentry's convention: input includes cache reads and writes. Pi's output already includes reasoning.
  assert.deepEqual(
    t1!.calls.map((c) => [c.usage!.input, c.usage!.cacheRead, c.usage!.cacheWrite, c.usage!.output, c.hidden ?? false]),
    [
      [7744, 0, 7738, 40, false],
      [7800, 7738, 56, 30, false],
      [7890, 7794, 90, 20, false],
      [7884, 7884, 0, 0, true],
    ],
  );
  assert.equal(t1!.calls[0]!.usage!.reasoning, 12);
  assert.equal(t1!.apiErrors, 1, "the failed request has no usage and is no call");
  assert.equal(t1!.calls[0]!.start, T + 2000, "message.timestamp is when the request started");
  assert.equal(t1!.calls[0]!.end, T + 5000, "the entry's timestamp is when it was written");
  assert.deepEqual(t1!.calls[0]!.input, [
    { id: "00000003", role: "user", parts: [{ type: "text", content: "fix calc.py" }] },
  ]);
  assert.equal(t1!.calls[1]!.input[0]!.role, "tool", "the next call's input is the previous call's tool results");
  assert.deepEqual(
    t1!.tools.map((t) => [t.name, t.isError ?? false, t.result, t.end]),
    [
      ["read", false, "def add", T + 6000],
      ["bash", true, "Traceback\n\nCommand exited with code 1", T + 10000],
    ],
  );
  assert.deepEqual(
    t2!.calls.map((c) => [c.finishReason, c.usage!.input, c.hidden ?? false]),
    [
      ["tool_call", 7920, false],
      ["tool:codemode", 500, true],
      ["compaction", 9000, false],
      ["stop", 800, false],
      ["branch_summary", 800, false],
    ],
  );
  assert.equal(t2!.compactions.length, 1);
  assert.equal(t2!.calls[3]!.afterCompaction, true);
  assert.deepEqual(
    t3!.calls[0]!.input.map((m) => m.parts[0]),
    [
      { type: "text", content: "fix calc.py" },
      { type: "text", content: "Tried tests." },
      { type: "text", content: "try another way" },
    ],
    "a branch's first call sees its path: the prompt it branched from, the branch summary and its own prompt",
  );
  assert.equal(t2!.calls.at(-1)!.finishReason, "branch_summary", "a side request goes with the run going on");

  const v = verifyTranscript(path, "pi");
  assert.ok(v.ok, JSON.stringify(v.checks.filter((c) => !c.ok)));
  const spans = buildSpans(s, { content: "full", environment: "test" });
  const read = spans.find((x) => spanAttr(x, "gen_ai.tool.name") === "read")!;
  assert.equal(spanAttr(read, "agent.tool.file_path"), "calc.py");
  assert.equal(spanAttr(spans[0]!, "agent.name"), "pi");
});

test("pi: a forked session sends only what was added after the fork", async () => {
  const root = freshHome();
  const dir = join(root, "sessions", "--work-proj--");
  const original = seed();
  const parentPath = original.write(dir);
  // Pi copies the entries verbatim under a new, later header.
  const fork = writer(FORK);
  fork.lines[0] = { ...fork.lines[0], timestamp: iso(100), parentSession: parentPath };
  fork.lines.push(...original.lines.slice(1));
  fork.add(120, { type: "message", message: { role: "user", content: "forked", timestamp: T + 120_000 } }, "0000000f");
  fork.assistant(120, 125, [{ type: "text", text: "ok" }], "stop", usage(3, 4, 0, 0));
  const forkPath = fork.write(dir);

  const s = parsePi(forkPath, { final: true });
  assert.equal(s.parentSessionId, SID);
  assert.deepEqual(
    s.turns.map((t) => [t.prompt, t.calls.length]),
    [["forked", 1]],
  );
  assert.ok(verifyTranscript(forkPath, "pi").ok);

  const sink = memorySink();
  const a = await syncTranscript(parentPath, { sink });
  const b = await syncTranscript(forkPath, { sink });
  assert.equal(a.sent, a.built);
  assert.deepEqual([b.built, b.sent], [2, 2], "the fork's own turn root and chat span");
});

test("pi: a run still going is held back until it stops", async () => {
  const root = freshHome();
  const w = writer(SID);
  w.user(1, "go");
  w.assistant(
    1,
    3,
    [{ type: "toolCall", id: "toolu_1", name: "bash", arguments: { command: "ls" } }],
    "toolUse",
    usage(5, 5, 0, 0),
  );
  const path = w.write(join(root, "sessions", "--work-proj--"));
  const now = T + 10_000;
  utimesSync(path, new Date(now), new Date(now));
  const sink = memorySink();
  const first = await syncTranscript(path, { sink, now });
  assert.equal(first.settled, false);
  assert.ok(
    !sink.batches.flat().some((x) => spanAttr(x, "gen_ai.operation.name") === "invoke_agent"),
    "no turn root while the run goes on",
  );
  w.toolResult(4, "toolu_1", "bash", "a.txt");
  w.assistant(4, 6, [{ type: "text", text: "done" }], "stop", usage(5, 5, 10, 0));
  w.write(join(root, "sessions", "--work-proj--"));
  utimesSync(path, new Date(now), new Date(now));
  const second = await syncTranscript(path, { sink, now });
  assert.equal(second.settled, true);
  assert.equal(sink.batches.flat().length, second.built, "every span sent exactly once");
});

test("pi: the extension wakes the hook with the session file, and the worker syncs it", async () => {
  const root = freshHome();
  process.env.PI_CODING_AGENT_DIR = join(root, "pi");
  const path = seed().write(join(root, "pi", "sessions", "--work-proj--"));
  assert.deepEqual(listPiSessions(0), [path]);
  const runSh = join(root, "run.sh");
  const got = join(root, "got.json");
  writeFileSync(runSh, `cat > ${got}\n`);
  chmodSync(runSh, 0o755);
  const extFile = join(root, "tattletale.mjs");
  writeFileSync(extFile, piExtensionSource(runSh));
  const { default: extension } = await import(pathToFileURL(extFile).href);
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  extension({ on: (event: string, fn: any) => handlers.set(event, fn) });
  assert.deepEqual([...handlers.keys()], ["session_start", "agent_settled", "session_shutdown"]);
  handlers.get("agent_settled")!({}, { sessionManager: { getSessionFile: () => path, getSessionId: () => SID } });
  for (let i = 0; i < 50 && !existsSync(got); i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(JSON.parse(readFileSync(got, "utf8")), {
    hook_event_name: "Stop",
    session_id: SID,
    transcript_path: path,
    agent: "pi",
  });
  // An ephemeral session (--no-session) has no file: nothing to wake.
  handlers.get("session_start")!({}, { sessionManager: { getSessionFile: () => undefined } });

  // The hook's payload, run through the CLI: the worker syncs the session.
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex") };
  const hook = spawnSync(process.execPath, ["--no-warnings", cli, "hook"], {
    env,
    input: readFileSync(got, "utf8"),
    encoding: "utf8",
  });
  assert.equal(hook.status, 0, hook.stderr);
  await runWorker(0);
  for (let i = 0; i < 100; i++) {
    const marks = existsSync(join(home(), "files.json"))
      ? JSON.parse(readFileSync(join(home(), "files.json"), "utf8"))
      : {};
    if (marks[path]) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail("the worker did not sync the session");
});

test("pi: install writes the extension under the Pi agent folder; uninstall removes it", () => {
  const root = freshHome();
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const env = { ...process.env, PI_CODING_AGENT_DIR: join(root, "pi"), PATH: "/usr/bin:/bin" };
  const ext = join(root, "pi", "extensions", "tattletale.ts");
  const install = spawnSync(process.execPath, ["--no-warnings", cli, "install", "--pi"], { env, encoding: "utf8" });
  assert.equal(install.status, 0, install.stderr);
  assert.ok(readFileSync(ext, "utf8").includes("hooks/run.sh"));
  const uninstall = spawnSync(process.execPath, ["--no-warnings", cli, "uninstall"], { env, encoding: "utf8" });
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.ok(!existsSync(ext));
});
