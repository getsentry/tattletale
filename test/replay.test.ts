import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { parseWhen, replayTargets } from "../src/replay.ts";
import { memorySink } from "../src/send.ts";
import { syncMany } from "../src/sync.ts";
import { cc, freshHome, usage, writeJsonl } from "./helpers.ts";

const day = 86_400_000;
const NOW = Date.parse("2026-11-06T12:00:00Z");

test("replay targets: folders are searched, subagents ride with their session, oldest first, filters apply", () => {
  const root = freshHome();
  const dir = join(root, "copied-from-laptop");
  mkdirSync(join(dir, "aaaa", "subagents"), { recursive: true });
  const touch = (path: string, ageDays: number) => {
    writeFileSync(path, "{}\n");
    utimesSync(path, new Date(NOW - ageDays * day), new Date(NOW - ageDays * day));
  };
  touch(join(dir, "aaaa.jsonl"), 40);
  touch(join(dir, "aaaa", "subagents", "agent-x.jsonl"), 40);
  touch(join(dir, "bbbb.jsonl"), 3);
  touch(join(dir, "rollout-2026-10-01T10-00-00-cccc.jsonl.zst"), 20);
  touch(join(dir, "notes.txt"), 1);

  const names = (opts: Partial<Parameters<typeof replayTargets>[0]>) =>
    replayTargets({ paths: [dir], sessions: [], ...opts }).map((t) => basename(t.path));
  assert.deepEqual(
    names({}),
    ["aaaa.jsonl", "rollout-2026-10-01T10-00-00-cccc.jsonl.zst", "bbbb.jsonl"],
    "oldest first, no subagent files, no non-transcripts",
  );
  assert.deepEqual(names({ since: NOW - 30 * day }), ["rollout-2026-10-01T10-00-00-cccc.jsonl.zst", "bbbb.jsonl"]);
  assert.deepEqual(names({ until: NOW - 10 * day }), ["aaaa.jsonl", "rollout-2026-10-01T10-00-00-cccc.jsonl.zst"]);
  assert.deepEqual(names({ sessions: ["bbbb"] }), ["bbbb.jsonl"]);
  assert.deepEqual(names({ agent: "codex" }), ["rollout-2026-10-01T10-00-00-cccc.jsonl.zst"]);
  assert.deepEqual(names({ limit: 1 }), ["aaaa.jsonl"]);
});

test("dates: ISO dates and day offsets; nonsense is an error", () => {
  assert.equal(parseWhen("30d", NOW), NOW - 30 * day);
  assert.equal(parseWhen("2026-10-01T00:00:00Z"), Date.parse("2026-10-01T00:00:00Z"));
  assert.throws(() => parseWhen("last tuesday"), /can't read date/);
});

test("replaying a transcript from anywhere sends it once; replaying again sends nothing", async () => {
  const root = freshHome();
  const S = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const dir = join(root, "old-machine");
  mkdirSync(dir, { recursive: true });
  writeJsonl(join(dir, `${S}.jsonl`), [
    cc.prompt(S, "u1", 0, "old work"),
    cc.assistant(S, "a1", 2, "msg_old", { type: "text", text: "done" }, usage(1, 10, 2, 3)),
  ]);
  const sink = memorySink();
  const first = await syncMany(replayTargets({ paths: [dir], sessions: [] }), { sink });
  assert.equal(first[0]!.sent, first[0]!.built);
  assert.ok(first[0]!.sent > 0);
  const again = await syncMany(replayTargets({ paths: [dir], sessions: [] }), { sink });
  assert.equal(again[0]!.sent, 0);
});
