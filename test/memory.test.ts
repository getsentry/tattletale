import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { jsonlRecords, type JsonlStats } from "../src/util.ts";
import { claudeProject, freshHome, writeImageHeavyClaude } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("a 120MB image-heavy session (with subagents) builds its spans inside a 96MB heap", () => {
  const dir = claudeProject(freshHome());
  const path = writeImageHeavyClaude(dir, "44444444-4444-4444-8444-444444444444", {
    turns: 40,
    imageChars: 1_500_000,
    subagents: 5,
  });
  const run = spawnSync(process.execPath, ["--no-warnings", "--max-old-space-size=96", cli, "spans", path, "--final"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr.slice(0, 500));
  const spans: any[] = JSON.parse(run.stdout);
  const ops = (op: string) => spans.filter((s) => s.attributes.some((a: any) => a.value.stringValue === op)).length;
  assert.equal(ops("chat"), 95, "2 calls per turn, 5 spawns, 2 calls per subagent");
  assert.equal(ops("execute_tool"), 50);
  assert.ok(run.stdout.includes("tweak sprite 39 ✓ — 日本"), "text survives chunked reading");
  assert.doesNotMatch(run.stdout, /[A-Za-z0-9+/]{1000}/, "no image data is sent");
});

test("jsonl streaming: lines across chunk boundaries, images replaced, everything else untouched", () => {
  const path = join(freshHome(), "t.jsonl");
  const image = "A".repeat(5 * 1024 * 1024);
  const prose = "word ".repeat(4000) + "ü日本";
  writeFileSync(
    path,
    [
      JSON.stringify({ n: 1, block: { type: "image", source: { data: image } }, tail: prose }),
      "",
      JSON.stringify({ n: 2, url: `data:image/jpeg;base64,${image}==`, short: "QUJD" }),
      JSON.stringify({ n: 3, note: `say "${"B".repeat(5000)}"` }),
      '{"n": 4, "half-writ',
    ].join("\n"),
  );
  const stats: JsonlStats = { badLines: 0 };
  const recs = [...jsonlRecords(path, stats)];
  assert.deepEqual(
    recs.map((r) => r.n),
    [1, 2, 3],
  );
  assert.equal(stats.badLines, 1, "a half-written last line is counted, not fatal");
  assert.equal(recs[0].block.source.data, `[base64 ${image.length} chars]`);
  assert.equal(recs[0].tail, prose);
  assert.equal(recs[1].url, `[base64 ${image.length + 25} chars]`);
  assert.equal(recs[1].short, "QUJD");
  assert.equal(recs[2].note, `say "${"B".repeat(5000)}"`, "base64-looking text inside a sentence is kept");
});

test("jsonl streaming: an image too long for a regex (8M chars) is still replaced", () => {
  const path = join(freshHome(), "t.jsonl");
  const image = "iVBORw0K+/".repeat(800_000);
  writeFileSync(path, JSON.stringify({ n: 1, url: `data:image/png;base64,${image}==`, detail: "high" }) + "\n");
  const recs = [...jsonlRecords(path)];
  assert.equal(recs[0].url, `[base64 ${image.length + 24} chars]`);
  assert.equal(recs[0].detail, "high");
});
