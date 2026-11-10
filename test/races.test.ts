// Several tattletale processes share one home: hook workers, a manual replay, the relay. These tests
// cover what keeps them from sending a span twice or dropping one for good.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { SendResult, Sink } from "../src/send.ts";
import type { OtlpSpan } from "../src/spans.ts";
import { enqueue, home, loadSent, markSent, takeJobs, tryLock } from "../src/state.ts";
import { sweepCandidates, syncMany } from "../src/sync.ts";
import { cc, claudeProject, freshHome, usage, writeJsonl } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** One finished turn. IDs carry the tag: span IDs come from them, and each session needs its own. */
const session = (id: string, tag: string) => [
  cc.prompt(id, `${tag}-u1`, 0, `work on ${tag}`),
  cc.assistant(
    id,
    `${tag}-a1`,
    2,
    `msg_${tag}_1`,
    { type: "tool_use", id: `toolu_${tag}`, name: "Bash", input: { command: "ls" } },
    usage(5, 100, 10, 20),
  ),
  cc.toolResult(id, `${tag}-r1`, 3, `toolu_${tag}`, "file.txt"),
  cc.assistant(id, `${tag}-a2`, 5, `msg_${tag}_2`, { type: "text", text: "done" }, usage(2, 150, 0, 8)),
  cc.stopMarker(id, `${tag}-m1`, 6),
];

const marks = (): Record<string, { mtimeMs: number; settled: boolean }> =>
  JSON.parse(readFileSync(join(home(), "files.json"), "utf8"));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function run(args: string[], env: Record<string, string>): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--no-warnings", cli, ...args], {
      env: { ...process.env, ...env },
      stdio: "ignore",
    });
    child.on("exit", resolve);
  });
}

test("two processes: a replay never re-sends what another process sent after the replay started", async () => {
  const root = freshHome();
  const dir = claudeProject(root);
  const pathA = writeJsonl(join(dir, `${A}.jsonl`), session(A, "a"));
  const pathB = writeJsonl(join(dir, `${B}.jsonl`), session(B, "b"));
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(pathA, old, old); // the replay goes oldest first: A, then B

  // A stand-in for Sentry. It holds its answer to the request carrying session A, so the replay is still
  // busy with A while the second process syncs B.
  const received: string[] = [];
  const replayIsSendingA = deferred();
  let heldA: ServerResponse | undefined;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const spans: OtlpSpan[] = JSON.parse(gunzipSync(Buffer.concat(chunks)).toString()).resourceSpans[0].scopeSpans[0]
        .spans;
      for (const s of spans) received.push(s.spanId);
      if (JSON.stringify(spans).includes(A)) {
        heldA = res;
        replayIsSendingA.resolve();
      } else res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const env = {
    TATTLETALE_HOME: home(),
    TATTLETALE_DSN: `http://key@127.0.0.1:${(server.address() as AddressInfo).port}/42`,
  };
  try {
    const replay = run(["replay", dir], env);
    await replayIsSendingA.promise;
    const other = run(["sync", pathB], env);
    // Let the other process finish if it can, then let the replay move on to B.
    await Promise.race([other, new Promise((r) => setTimeout(r, 1500))]);
    heldA?.end("{}");
    assert.deepEqual([await replay, await other], [0, 0]);
  } finally {
    server.close();
  }
  const twice = received.filter((id, i) => received.indexOf(id) !== i);
  assert.deepEqual(twice, [], "no span reached Sentry twice");
  assert.equal(new Set(received).size, 8, "both sessions arrived: 2 agent spans, 4 model calls, 2 tool calls");
});

test("ledger: IDs another process appended are seen on the next read, once their line is complete", () => {
  freshHome();
  markSent(["1111111111111111"]);
  assert.equal(loadSent().size, 1);
  appendFileSync(join(home(), "sent.log"), "2222222222222222\n3333");
  assert.ok(loadSent().has("2222222222222222"));
  assert.ok(!loadSent().has("3333"), "a line still being written is left for the next read");
  appendFileSync(join(home(), "sent.log"), "333333333333\n");
  assert.ok(loadSent().has("3333333333333333"));
  assert.equal(loadSent().size, 3);
});

test("locks: a holder whose lock was taken over does not remove the new holder's lock on release", () => {
  freshHome();
  const releaseFirst = tryLock("send");
  assert.ok(releaseFirst);
  assert.equal(tryLock("send"), undefined, "held");
  // Nobody touched the lock for 11 minutes (a hung or suspended holder): the next process takes it over.
  const lock = join(home(), "locks", "send.lock");
  const longAgo = new Date(Date.now() - 11 * 60_000);
  utimesSync(lock, longAgo, longAgo);
  const releaseSecond = tryLock("send");
  assert.ok(releaseSecond, "a stale lock is taken over");
  releaseFirst();
  assert.equal(tryLock("send"), undefined, "the first holder's release left the second holder's lock alone");
  releaseSecond();
  const releaseThird = tryLock("send");
  assert.ok(releaseThird, "free again once its real holder releases");
  releaseThird();
});

test("locks: a lock left by a dead process is taken over at once", () => {
  freshHome();
  mkdirSync(join(home(), "locks"), { recursive: true });
  writeFileSync(join(home(), "locks", "worker.lock"), "999999999 leftover");
  const release = tryLock("worker");
  assert.ok(release);
  release();
  assert.ok(!existsSync(join(home(), "locks", "worker.lock")));
});

test("queue: a job that is still being written is not taken or deleted", () => {
  freshHome();
  enqueue({ event: "Stop", transcriptPath: "/tmp/x.jsonl", at: 1 });
  const halfWritten = join(home(), "queue", "123-456-abcdef.tmp");
  writeFileSync(halfWritten, '{"event":"St');
  assert.deepEqual(
    takeJobs().map((j) => j.event),
    ["Stop"],
  );
  assert.ok(existsSync(halfWritten));
  assert.deepEqual(takeJobs(), []);
});

test("a send that failed is retried by the sweep however old the transcript is by then", async () => {
  const root = freshHome();
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  process.env.CODEX_HOME = join(root, "codex");
  const path = writeJsonl(join(claudeProject(root), `${A}.jsonl`), session(A, "a"));
  const down: Sink = { name: "down", send: async () => ({ ok: false, retryable: true, message: "offline" }) };
  const [failed] = await syncMany([{ path, final: true }], { sink: down });
  assert.ok(failed!.failed > 0);
  assert.equal(loadSent().size, 0);

  // Friday's last turn failed to send; the next hook fires on Wednesday.
  const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000);
  utimesSync(path, fiveDaysAgo, fiveDaysAgo);
  const candidates = sweepCandidates(2, marks());
  assert.deepEqual(
    candidates.map((c) => c.path),
    [path],
  );
  const sent: OtlpSpan[] = [];
  const up: Sink = { name: "up", send: async (spans) => (sent.push(...spans), { ok: true }) };
  await syncMany(candidates, { sink: up });
  assert.equal(sent.length, 4);
  assert.deepEqual(sweepCandidates(2, marks()), [], "fully sent: not looked at again");
});

test("Sentry unreachable: the run stops at the first failure and leaves the rest for the next sweep", async () => {
  const root = freshHome();
  const dir = claudeProject(root);
  const paths = [
    writeJsonl(join(dir, `${A}.jsonl`), session(A, "a")),
    writeJsonl(join(dir, `${B}.jsonl`), session(B, "b")),
    writeJsonl(join(dir, `${C}.jsonl`), session(C, "c")),
  ];
  let attempts = 0;
  const down: Sink = {
    name: "down",
    send: async (): Promise<SendResult> => (attempts++, { ok: false, retryable: true, message: "offline" }),
  };
  const reports = await syncMany(
    paths.map((path) => ({ path, final: true })),
    { sink: down },
  );
  assert.equal(attempts, 1, "one failed request, not one per session");
  assert.equal(reports.length, 3);
  assert.deepEqual(
    paths.map((p) => marks()[p]?.settled),
    [false, false, false],
  );
});

test("a transcript that crashes the sync is not retried on every sweep, only once it changes", async () => {
  const root = freshHome();
  delete process.env.TATTLETALE_DSN; // no error report over the network
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  process.env.CODEX_HOME = join(root, "codex");
  const path = writeJsonl(join(claudeProject(root), `${A}.jsonl`), session(A, "a"));
  const broken: Sink = {
    name: "broken",
    send: async () => {
      throw new Error("boom");
    },
  };
  const [crashed] = await syncMany([{ path, final: true }], { sink: broken });
  assert.match(crashed!.error ?? "", /boom/);
  assert.deepEqual(sweepCandidates(2, marks()), [], "left alone while nothing changed");
  appendFileSync(path, JSON.stringify(cc.prompt(A, "a-u2", 60, "more")) + "\n");
  const later = new Date(Date.now() + 5000);
  utimesSync(path, later, later);
  assert.deepEqual(
    sweepCandidates(2, marks()).map((c) => c.path),
    [path],
    "tried again once the transcript changes",
  );
});
