// Local OTLP/HTTP receiver for Claude Code's native telemetry. Claude Code exports spans and log events in
// separate batches, so each trace is held until it has gone quiet, then rewritten to Sentry's gen_ai
// conventions (otel-claude.ts) together with the log events seen so far, and forwarded to the DSN.
//
// It also records which sessions it has seen (and when), so transcript sync can leave those to OTel.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { claudeProjectsDir } from "./claude.ts";
import { mapClaudeOtel } from "./otel-claude.ts";
import { reportError } from "./report.ts";
import { batches, sentrySink } from "./send.ts";
import type { Sink } from "./send.ts";
import type { OtlpSpan } from "./spans.ts";
import { loadConfig, loadOtelSessions, loadSent, log, markOtelSession, markSent } from "./state.ts";
import type { Config } from "./state.ts";

const STRIP_IN_METADATA_MODE = new Set([
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
  "user_prompt",
  "full_command",
]);
const LOG_TTL_MS = 30 * 60 * 1000;
const MAX_LOGS = 50_000;

interface Bucket {
  spans: any[];
  firstAt: number;
  lastAt: number;
  hasRoot: boolean;
  sessionId?: string;
  attempts: number;
}

export interface RelayOptions {
  config?: Config;
  sink?: Sink;
  now?: () => number;
  /** Flush a trace this long after its last span once its turn root has arrived. */
  rootQuietMs?: number;
  /** Flush a trace without a root after this much silence (late subagent spans, crashes). */
  quietMs?: number;
  /** Never hold a trace longer than this. */
  maxAgeMs?: number;
}

export interface Relay {
  receive(path: string, body: any): void;
  flush(force?: boolean): Promise<{ sent: number; skipped: number; failed: number }>;
  pending(): number;
}

const attr = (span: any, key: string) => {
  const v = (span.attributes ?? []).find((a: any) => a.key === key)?.value;
  return v ? (v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue) : undefined;
};

/** cwd and Claude Code version of a session, from its local transcript (OTel carries neither). */
const sessionInfoCache = new Map<string, { cwd?: string; version?: string }>();
export function sessionInfo(sessionId: string): { cwd?: string; version?: string } {
  const hit = sessionInfoCache.get(sessionId);
  if (hit?.cwd) return hit;
  const info: { cwd?: string; version?: string } = {};
  const root = claudeProjectsDir();
  if (existsSync(root)) {
    for (const dir of readdirSync(root)) {
      const path = join(root, dir, `${sessionId}.jsonl`);
      if (!existsSync(path)) continue;
      const head = readFileSync(path, "utf8").slice(0, 256 * 1024);
      info.cwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head)?.[1]?.replace(/\\(.)/g, "$1");
      info.version = /"version":"([^"]+)"/.exec(head)?.[1];
      break;
    }
  }
  sessionInfoCache.set(sessionId, info);
  return info;
}

const expand = (p: string) => p.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
function allowed(cwd: string | undefined, config: Config): boolean {
  if (config.include.length && !(cwd && config.include.some((p) => cwd.startsWith(expand(p))))) return false;
  return !(cwd && config.ignore.some((p) => cwd.startsWith(expand(p))));
}

export function createRelay(opts: RelayOptions = {}): Relay {
  const now = opts.now ?? Date.now;
  const rootQuietMs = opts.rootQuietMs ?? 5_000;
  const quietMs = opts.quietMs ?? 60_000;
  const maxAgeMs = opts.maxAgeMs ?? 20 * 60_000;
  const buckets = new Map<string, Bucket>();
  let logs: { at: number; record: any }[] = [];
  const seenSessions = loadOtelSessions();

  const receive = (path: string, body: any) => {
    const at = now();
    if (path.endsWith("/v1/traces")) {
      for (const rs of body?.resourceSpans ?? [])
        for (const ss of rs.scopeSpans ?? [])
          for (const span of ss.spans ?? []) {
            const b = buckets.get(span.traceId) ?? { spans: [], firstAt: at, lastAt: at, hasRoot: false, attempts: 0 };
            b.spans.push(span);
            b.lastAt = at;
            if (!span.parentSpanId && span.name === "claude_code.interaction") b.hasRoot = true;
            const sid = attr(span, "session.id");
            if (typeof sid === "string") {
              b.sessionId ??= sid;
              if (!seenSessions.has(sid)) {
                const startMs = Number(BigInt(span.startTimeUnixNano ?? "0") / 1_000_000n) || at;
                seenSessions.set(sid, startMs);
                markOtelSession(sid, startMs);
              }
            }
            buckets.set(span.traceId, b);
          }
    } else if (path.endsWith("/v1/logs")) {
      for (const rl of body?.resourceLogs ?? [])
        for (const sl of rl.scopeLogs ?? []) for (const record of sl.logRecords ?? []) logs.push({ at, record });
      if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
    }
  };

  const flush = async (force = false) => {
    const config = opts.config ?? loadConfig();
    const sink = opts.sink ?? (config.dsn ? sentrySink(config.dsn) : undefined);
    const t = now();
    logs = logs.filter((l) => t - l.at < LOG_TTL_MS);
    const report = { sent: 0, skipped: 0, failed: 0 };
    for (const [traceId, b] of buckets) {
      const quiet = t - b.lastAt;
      const ready = force || (b.hasRoot && quiet >= rootQuietMs) || quiet >= quietMs || t - b.firstAt >= maxAgeMs;
      if (!ready) continue;
      const info = b.sessionId ? sessionInfo(b.sessionId) : {};
      if (config.disabled || !allowed(info.cwd, config)) {
        buckets.delete(traceId);
        report.skipped += b.spans.length;
        continue;
      }
      if (!sink) {
        report.failed += b.spans.length;
        continue;
      }
      let spans: OtlpSpan[];
      try {
        spans = mapClaudeOtel({
          traces: [{ resourceSpans: [{ scopeSpans: [{ spans: b.spans }] }] }],
          logs: [{ resourceLogs: [{ scopeLogs: [{ logRecords: logs.map((l) => l.record) }] }] }],
        });
      } catch (err) {
        buckets.delete(traceId);
        log(`relay: mapping trace ${traceId} failed: ${err}`);
        await reportError(err, { stage: "relay-map" });
        continue;
      }
      const common = [
        { key: "sentry.environment", value: { stringValue: config.environment } },
        { key: "agent.name", value: { stringValue: "claude-code" } },
        { key: "agent.source", value: { stringValue: "otel" } },
        ...(info.cwd ? [{ key: "agent.session.cwd", value: { stringValue: info.cwd } }] : []),
        ...(info.version ? [{ key: "sentry.release", value: { stringValue: `claude-code@${info.version}` } }] : []),
        ...(config.user ? [{ key: "user.id", value: { stringValue: config.user } }] : []),
      ];
      const sent = loadSent();
      const todo = spans.filter((s) => !sent.has(s.spanId));
      for (const s of todo)
        s.attributes = [
          ...s.attributes.filter((a) => !(config.content === "metadata" && STRIP_IN_METADATA_MODE.has(a.key))),
          ...common,
        ];
      let ok = true;
      for (const batch of batches(todo)) {
        const res = await sink.send(batch);
        if (res.ok) {
          markSent(batch.map((s) => s.spanId));
          report.sent += batch.length;
        } else {
          ok = false;
          report.failed += batch.length;
          log(`relay: send failed for trace ${traceId}: ${res.message}`);
          break;
        }
      }
      // Keep a failed trace for a few more attempts; spans already sent are skipped via the ledger.
      if (ok || ++b.attempts >= 5) buckets.delete(traceId);
    }
    return report;
  };

  return { receive, flush, pending: () => [...buckets.values()].reduce((n, b) => n + b.spans.length, 0) };
}

export function relayUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** Starts the HTTP server. Resolves once listening; rejects with EADDRINUSE if a relay already runs. */
export function serveRelay(port: number, relay: Relay = createRelay(), tickMs = 2_000): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`tattletale relay, ${relay.pending()} spans pending\n`);
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const type = String(req.headers["content-type"] ?? "");
      if (!type.includes("json")) {
        log(`relay: rejected ${type || "unknown"} body on ${req.url}; set OTEL_EXPORTER_OTLP_PROTOCOL=http/json`);
        res.writeHead(415, { "content-type": "application/json" });
        res.end('{"error":"tattletale relay accepts OTLP/HTTP JSON only"}');
        return;
      }
      try {
        let body = Buffer.concat(chunks);
        if (req.headers["content-encoding"] === "gzip") body = gunzipSync(body);
        relay.receive(req.url ?? "", JSON.parse(body.toString("utf8")));
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  });
  const timer = setInterval(() => {
    relay.flush().catch((err) => log(`relay: flush failed: ${err}`));
  }, tickMs);
  server.on("close", () => clearInterval(timer));
  return new Promise((resolve, reject) => {
    server.once("error", (err) => {
      clearInterval(timer);
      reject(err);
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

/** True if something answers as the relay on this port. */
export async function relayAlive(port: number, timeoutMs = 300): Promise<boolean> {
  try {
    const res = await fetch(relayUrl(port), { signal: AbortSignal.timeout(timeoutMs) });
    return (await res.text()).startsWith("tattletale relay");
  } catch {
    return false;
  }
}
