import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { sentrySink } from "../src/send.ts";
import { loadSent } from "../src/state.ts";
import { syncTranscript } from "../src/sync.ts";
import { cc, claudeProject, freshHome, usage, writeJsonl } from "./helpers.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** One finished turn: an agent span, two model calls, a tool call. */
const turn = () => [
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
];

const fetchFailed = (cause: object) => new TypeError("fetch failed", { cause });
const answering = (status: number) => (async () => new Response("no", { status })) as unknown as typeof fetch;

test("only a rejected payload is a bad batch; every other failure keeps the spans for a retry", async () => {
  const span = { spanId: "00" } as never;
  const result = async (status: number) =>
    sentrySink("https://key@o1.ingest.example.com/42", answering(status)).send([span]);
  for (const status of [401, 403, 404, 429, 500, 503])
    assert.partialDeepStrictEqual(await result(status), { ok: false, retryable: true });
  for (const status of [400, 413, 422])
    assert.partialDeepStrictEqual(await result(status), { ok: false, retryable: false });
  const failing = (error: unknown) =>
    sentrySink("https://key@o1.ingest.example.com/42", (async () => {
      throw error;
    }) as unknown as typeof fetch).send([span]);
  // The request never left: safe to send again.
  for (const cause of [
    { code: "ENOTFOUND" },
    { code: "ECONNREFUSED" },
    { code: "ECONNREFUSED", errors: [{ code: "ECONNREFUSED" }, { code: "ENETUNREACH" }] },
    { code: "UND_ERR_CONNECT_TIMEOUT" },
    { code: "ERR_SSL_PACKET_LENGTH_TOO_LONG" },
    { code: "CERT_HAS_EXPIRED" },
  ])
    assert.partialDeepStrictEqual(await failing(fetchFailed(cause)), { retryable: true, maybeDelivered: false });
  // No answer, but Sentry may have it.
  for (const error of [
    fetchFailed({ code: "UND_ERR_SOCKET" }),
    fetchFailed({ code: "ECONNRESET" }),
    new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    new TypeError("fetch failed"),
  ])
    assert.partialDeepStrictEqual(await failing(error), { retryable: true, maybeDelivered: true });
});

test("real sockets: nothing listening is retried; a connection dropped after the upload is never sent again", async () => {
  const root = freshHome();
  const path = writeJsonl(join(claudeProject(root), `${A}.jsonl`), turn());
  const received: number[] = [];
  let drop = true;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push(
        JSON.parse(gunzipSync(Buffer.concat(chunks)).toString()).resourceSpans[0].scopeSpans[0].spans.length,
      );
      if (drop) req.socket.destroy();
      else res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dsn = `http://key@127.0.0.1:${(server.address() as AddressInfo).port}/42`;
  try {
    // Sentry got the batch, the answer was lost.
    const lost = await syncTranscript(path, { sink: sentrySink(dsn), final: true });
    assert.equal(lost.failed, 4);
    assert.equal(loadSent().size, 4, "recorded, as unverified");
    drop = false;
    const again = await syncTranscript(path, { sink: sentrySink(dsn), final: true });
    assert.equal(again.sent, 0);
    assert.deepEqual(received, [4], "the batch reached Sentry once and was not sent again");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // Same port, nothing listening now: the request can't have left, so the spans stay out of the ledger.
  freshHome();
  const refused = await syncTranscript(path, { sink: sentrySink(dsn), final: true });
  assert.equal(refused.failed, 4);
  assert.equal(loadSent().size, 0);
});

test("a refused DSN (401) is not a bad span: nothing is written off as sent", async () => {
  const root = freshHome();
  const path = writeJsonl(join(claudeProject(root), `${A}.jsonl`), turn());
  let requests = 0;
  const refuse = (async () => (requests++, new Response("invalid key", { status: 401 }))) as unknown as typeof fetch;
  const report = await syncTranscript(path, { sink: sentrySink("https://key@o1.ingest.example.com/42", refuse) });
  assert.equal(loadSent().size, 0, "the ledger is untouched, so everything is sent once the DSN works");
  assert.equal(report.poisoned, 0);
  assert.equal(report.failed, 4);
  assert.equal(requests, 1, "no bisecting");
});
