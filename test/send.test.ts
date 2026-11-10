import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { sentrySink } from "../src/send.ts";
import { loadSent } from "../src/state.ts";
import { syncTranscript } from "../src/sync.ts";
import { cc, claudeProject, freshHome, usage, writeJsonl } from "./helpers.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const answering = (status: number) => (async () => new Response("no", { status })) as unknown as typeof fetch;

test("only a rejected payload is a bad batch; every other failure keeps the spans for a retry", async () => {
  const span = { spanId: "00" } as never;
  const result = async (status: number) =>
    sentrySink("https://key@o1.ingest.example.com/42", answering(status)).send([span]);
  for (const status of [401, 403, 404, 429, 500, 503])
    assert.partialDeepStrictEqual(await result(status), { ok: false, retryable: true });
  for (const status of [400, 413, 422])
    assert.partialDeepStrictEqual(await result(status), { ok: false, retryable: false });
  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  assert.partialDeepStrictEqual(await sentrySink("https://key@o1.ingest.example.com/42", offline).send([span]), {
    ok: false,
    retryable: true,
  });
});

test("a refused DSN (401) is not a bad span: nothing is written off as sent", async () => {
  const root = freshHome();
  const path = writeJsonl(join(claudeProject(root), `${A}.jsonl`), [
    cc.prompt(A, "u1", 0, "hi"),
    cc.assistant(
      A,
      "a1",
      2,
      "msg_send_1",
      { type: "tool_use", id: "toolu_send", name: "Bash", input: {} },
      usage(5, 100, 10, 20),
    ),
    cc.toolResult(A, "r1", 3, "toolu_send", "ok"),
    cc.assistant(A, "a2", 5, "msg_send_2", { type: "text", text: "done" }, usage(2, 150, 0, 8)),
    cc.stopMarker(A, "m1", 6),
  ]);
  let requests = 0;
  const refuse = (async () => (requests++, new Response("invalid key", { status: 401 }))) as unknown as typeof fetch;
  const report = await syncTranscript(path, { sink: sentrySink("https://key@o1.ingest.example.com/42", refuse) });
  assert.equal(loadSent().size, 0, "the ledger is untouched, so everything is sent once the DSN works");
  assert.equal(report.poisoned, 0);
  assert.equal(report.failed, 4);
  assert.equal(requests, 1, "no bisecting");
});
