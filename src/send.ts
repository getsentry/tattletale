// Sinks: where built spans go. Sentry over OTLP/HTTP JSON, or a local file / memory for testing.

import { appendFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import type { OtlpSpan } from "./spans.ts";
import { VERSION } from "./version.ts";

export type SendResult =
  | { ok: true; rejected?: number; message?: string }
  | { ok: false; retryable: boolean; status?: number; message: string };

export interface Sink {
  name: string;
  send(spans: OtlpSpan[]): Promise<SendResult>;
}

export function otlpPayload(spans: OtlpSpan[]): unknown {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "tattletale" } }] },
        scopeSpans: [{ scope: { name: "tattletale", version: VERSION }, spans }],
      },
    ],
  };
}

export function otlpEndpoint(dsn: string): { url: string; publicKey: string } {
  const u = new URL(dsn);
  const projectId = u.pathname.replace(/^\/+|\/+$/g, "");
  if (!u.username || !projectId) throw new Error(`Invalid DSN: ${dsn}`);
  return { url: `${u.protocol}//${u.host}/api/${projectId}/integration/otlp/v1/traces`, publicKey: u.username };
}

export function sentrySink(dsn: string, fetchImpl: typeof fetch = fetch): Sink {
  const { url, publicKey } = otlpEndpoint(dsn);
  return {
    name: `sentry:${new URL(dsn).host}`,
    async send(spans) {
      const body = gzipSync(JSON.stringify(otlpPayload(spans)));
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
            "x-sentry-auth": `sentry sentry_key=${publicKey}, sentry_version=7, sentry_client=tattletale/${VERSION}`,
          },
          body,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        return { ok: false, retryable: true, message: String(err) };
      }
      const text = await res.text().catch(() => "");
      if (res.ok) {
        let rejected: number | undefined;
        try {
          rejected = Number(JSON.parse(text)?.partialSuccess?.rejectedSpans) || undefined;
        } catch {}
        return { ok: true, rejected, message: text.slice(0, 500) || undefined };
      }
      const retryable = res.status === 429 || res.status >= 500;
      return { ok: false, retryable, status: res.status, message: `${res.status} ${text.slice(0, 500)}` };
    },
  };
}

export function fileSink(path: string): Sink {
  return {
    name: `file:${path}`,
    async send(spans) {
      appendFileSync(path, spans.map((s) => JSON.stringify(s)).join("\n") + "\n");
      return { ok: true };
    },
  };
}

export function memorySink(): Sink & { batches: OtlpSpan[][]; fail?: SendResult } {
  const sink = {
    name: "memory",
    batches: [] as OtlpSpan[][],
    fail: undefined as SendResult | undefined,
    async send(spans: OtlpSpan[]): Promise<SendResult> {
      if (sink.fail) return sink.fail;
      sink.batches.push(spans);
      return { ok: true };
    },
  };
  return sink;
}

/** Splits into requests of at most `maxSpans` spans and roughly `maxBytes` of JSON. */
export function batches(spans: OtlpSpan[], maxSpans = 200, maxBytes = 3_000_000): OtlpSpan[][] {
  const out: OtlpSpan[][] = [];
  let cur: OtlpSpan[] = [];
  let bytes = 0;
  for (const s of spans) {
    const size = JSON.stringify(s).length;
    if (cur.length && (cur.length >= maxSpans || bytes + size > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(s);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}
