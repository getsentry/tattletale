// Parse a transcript, build spans, send only what the ledger hasn't seen. Safe to run any number of times.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listClaudeSessions, parseClaude } from "./claude.ts";
import { listCodexSessions, parseCodex } from "./codex.ts";
import type { AgentName, ParseOptions, Session } from "./model.ts";
import { batches, sentrySink } from "./send.ts";
import type { Sink } from "./send.ts";
import { buildSpans } from "./spans.ts";
import type { OtlpSpan } from "./spans.ts";
import {
  clearPending,
  home,
  loadConfig,
  loadOtelSessions,
  loadSent,
  log,
  markSent,
  queueLength,
  recoverPending,
  takeJobs,
  tryLock,
  withLock,
  writePending,
} from "./state.ts";
import type { Config } from "./state.ts";
import { reportError } from "./report.ts";
import { hashHex } from "./util.ts";

export function detectAgent(path: string): AgentName {
  return /(^|\/)\.codex\/|rollout-[^/]*\.jsonl/.test(path) ? "codex" : "claude-code";
}

export function parseSession(path: string, agent: AgentName = detectAgent(path), opts: ParseOptions = {}): Session {
  return agent === "codex" ? parseCodex(path, opts) : parseClaude(path, opts);
}

export interface SyncOptions {
  agent?: AgentName;
  final?: boolean;
  sink?: Sink;
  config?: Config;
  dryRun?: boolean;
  now?: number;
}

export interface SyncReport {
  path: string;
  agent: AgentName;
  sessionId?: string;
  built: number;
  alreadySent: number;
  sent: number;
  failed: number;
  poisoned: number;
  rejected: number;
  /** Every turn/subagent is complete and every span is in the ledger. */
  settled: boolean;
  skipped?: string;
  error?: string;
}

const expand = (prefix: string) => prefix.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");

const OTEL_GRACE_MS = 30 * 60 * 1000;
/** The transcript stamps a prompt slightly before Claude Code's OTel turn span starts. Telemetry is on from process
 *  start, so a resumed session's earlier turns are far older than this; a misjudged turn is skipped, never doubled. */
const OTEL_OVERLAP_MS = 2 * 60 * 1000;

/**
 * With claudeSource "otel", each Claude Code session has exactly one source so Sentry never gets it twice:
 * turns from before the relay first saw the session come from the transcript, the rest from OTel. A session
 * touched since the switch that the relay never saw (telemetry not active there) falls back to the
 * transcript once idle; until then it waits.
 */
export function applyOtelOwnership(session: Session, config: Config, now: number, mtimeMs: number): "ok" | "wait" {
  if (session.agent !== "claude-code" || config.claudeSource !== "otel") return "ok";
  const firstOtel = loadOtelSessions().get(session.sessionId);
  if (firstOtel !== undefined) {
    const cutoff = firstOtel - OTEL_OVERLAP_MS;
    session.turns = session.turns.filter((t) => t.start < cutoff);
    session.subagents = session.subagents.filter((r) => r.start < cutoff);
    return "ok";
  }
  if (config.otelSince === undefined || mtimeMs < config.otelSince) return "ok";
  return now - mtimeMs >= OTEL_GRACE_MS ? "ok" : "wait";
}

function ignored(cwd: string | undefined, config: Config): boolean {
  if (config.include.length && !(cwd && config.include.some((p) => cwd.startsWith(expand(p))))) return true;
  return !!cwd && config.ignore.some((p) => cwd.startsWith(expand(p)));
}

/** Sends one batch; on a non-retryable rejection, bisects to isolate (and skip) the bad span. */
async function sendBatch(sink: Sink, key: string, batch: OtlpSpan[], report: SyncReport): Promise<boolean> {
  const ids = batch.map((s) => s.spanId);
  writePending(key, ids);
  const res = await sink.send(batch);
  clearPending(key);
  if (res.ok) {
    markSent(ids);
    report.sent += ids.length;
    if (res.rejected) {
      report.rejected += res.rejected;
      log(`${key}: Sentry rejected ${res.rejected} of ${ids.length} spans: ${res.message ?? ""}`);
    }
    return true;
  }
  if (res.retryable) {
    report.failed += ids.length;
    report.error = res.message;
    log(`${key}: send failed (will retry): ${res.message}`);
    return false;
  }
  if (batch.length > 1) {
    const mid = Math.floor(batch.length / 2);
    const left = await sendBatch(sink, key, batch.slice(0, mid), report);
    return (await sendBatch(sink, key, batch.slice(mid), report)) && left;
  }
  // A single span Sentry refuses outright would otherwise block every future sync of this session.
  markSent(ids);
  report.poisoned++;
  log(`${key}: span ${ids[0]} permanently rejected, skipping: ${res.message}`);
  return true;
}

export async function syncTranscript(path: string, opts: SyncOptions = {}): Promise<SyncReport> {
  const config = opts.config ?? loadConfig();
  const agent = opts.agent ?? detectAgent(path);
  const report: SyncReport = {
    path,
    agent,
    built: 0,
    alreadySent: 0,
    sent: 0,
    failed: 0,
    poisoned: 0,
    rejected: 0,
    settled: false,
  };
  if (config.disabled) return { ...report, skipped: "disabled" };
  if (!existsSync(path)) return { ...report, skipped: "missing" };

  const session = parseSession(path, agent, { final: opts.final, now: opts.now });
  report.sessionId = session.sessionId;
  if (ignored(session.cwd, config)) return { ...report, skipped: "ignored path" };
  if (applyOtelOwnership(session, config, opts.now ?? Date.now(), statSync(path).mtimeMs) === "wait")
    return { ...report, skipped: "waiting for OTel relay" };
  const spans = buildSpans(session, { content: config.content, environment: config.environment, user: config.user });
  report.built = spans.length;
  const complete = session.turns.every((t) => t.complete) && session.subagents.every((s) => s.complete);

  const sink = opts.sink ?? (config.dsn ? sentrySink(config.dsn) : undefined);
  if (!sink && !opts.dryRun) return { ...report, error: "no DSN configured (run: tattletale setup --dsn ...)" };

  const key = `${agent}:${session.sessionId}`;
  const done = await withLock(`session-${hashHex(16, key)}`, async () => {
    recoverPending(key);
    const sent = loadSent();
    const todo = spans.filter((s) => !sent.has(s.spanId));
    report.alreadySent = spans.length - todo.length;
    if (opts.dryRun) {
      report.sent = todo.length;
      return true;
    }
    for (const batch of batches(todo)) {
      if (!(await sendBatch(sink!, key, batch, report))) break;
    }
    return true;
  });
  if (!done) return { ...report, error: "session locked by another process" };
  report.settled = complete && report.failed === 0 && !opts.dryRun;
  return report;
}

// ---- background worker ----

interface FileMark {
  mtimeMs: number;
  settled: boolean;
}

function loadMarks(): Record<string, FileMark> {
  try {
    return JSON.parse(readFileSync(join(home(), "files.json"), "utf8"));
  } catch {
    return {};
  }
}

function saveMarks(marks: Record<string, FileMark>): void {
  try {
    writeFileSync(join(home(), "files.json"), JSON.stringify(marks));
  } catch {}
}

const FINAL_EVENTS = new Set(["Stop", "SessionEnd", "stop", "sessionEnd"]);

/** Recently modified transcripts that are not yet settled. Catches sessions whose hooks never fired. */
export function sweepCandidates(days: number, marks: Record<string, FileMark>): { path: string; agent: AgentName }[] {
  const since = Date.now() - days * 86_400_000;
  const out: { path: string; agent: AgentName }[] = [];
  for (const path of listClaudeSessions(since)) out.push({ path, agent: "claude-code" });
  for (const path of listCodexSessions(since)) out.push({ path, agent: "codex" });
  return out.filter(({ path }) => {
    const mark = marks[path];
    return !mark || !mark.settled || mark.mtimeMs !== statSync(path).mtimeMs;
  });
}

export async function syncMany(
  items: { path: string; agent?: AgentName; final?: boolean }[],
  opts: SyncOptions = {},
  onReport?: (r: SyncReport) => void,
): Promise<SyncReport[]> {
  const marks = loadMarks();
  const reports: SyncReport[] = [];
  for (const item of items) {
    let report: SyncReport;
    if (!existsSync(item.path)) {
      // SessionStart fires before the agent has written its transcript.
      reports.push({
        path: item.path,
        agent: item.agent ?? detectAgent(item.path),
        built: 0,
        alreadySent: 0,
        sent: 0,
        failed: 0,
        poisoned: 0,
        rejected: 0,
        settled: false,
        skipped: "missing",
      });
      continue;
    }
    try {
      const mtimeMs = statSync(item.path).mtimeMs;
      report = await syncTranscript(item.path, { ...opts, agent: item.agent, final: item.final });
      // Intentionally skipped sessions count as settled until the file changes, so sweeps don't re-parse them.
      if (!opts.dryRun) marks[item.path] = { mtimeMs, settled: report.settled || report.skipped === "ignored path" };
    } catch (err) {
      report = {
        path: item.path,
        agent: item.agent ?? detectAgent(item.path),
        built: 0,
        alreadySent: 0,
        sent: 0,
        failed: 0,
        poisoned: 0,
        rejected: 0,
        settled: false,
        error: String((err as Error)?.stack ?? err),
      };
      log(`sync ${item.path} crashed: ${report.error}`);
      await reportError(err, { stage: "sync", agent: report.agent });
    }
    reports.push(report);
    onReport?.(report);
    if (!opts.dryRun) saveMarks(marks);
  }
  return reports;
}

/** Drains the hook queue. Only one worker runs at a time; it re-checks the queue after releasing the lock. */
export async function runWorker(sweepDays = 2): Promise<void> {
  for (;;) {
    const release = tryLock("worker");
    if (!release) return;
    try {
      for (;;) {
        const jobs = takeJobs();
        if (!jobs.length) break;
        const byPath = new Map<string, { path: string; agent?: AgentName; final: boolean }>();
        let sweep = false;
        for (const job of jobs) {
          if (job.event === "SessionStart" || job.event === "sessionStart" || job.event === "sweep") sweep = true;
          if (!job.transcriptPath) continue;
          const entry = byPath.get(job.transcriptPath) ?? {
            path: job.transcriptPath,
            agent: job.agent as AgentName | undefined,
            final: false,
          };
          entry.final ||= FINAL_EVENTS.has(job.event ?? "");
          byPath.set(job.transcriptPath, entry);
        }
        const reports = await syncMany([...byPath.values()]);
        for (const r of reports)
          log(
            `sync ${r.agent} ${r.sessionId ?? r.path}: built=${r.built} sent=${r.sent} already=${r.alreadySent} failed=${r.failed}${r.skipped ? ` skipped=${r.skipped}` : ""}${r.error ? ` error=${r.error}` : ""}`,
          );
        if (sweep) {
          const candidates = sweepCandidates(sweepDays, loadMarks()).filter((c) => !byPath.has(c.path));
          const swept = await syncMany(candidates);
          const sent = swept.reduce((n, r) => n + r.sent, 0);
          log(`sweep: ${candidates.length} candidates, ${sent} spans sent`);
        }
      }
    } finally {
      release();
    }
    if (queueLength() === 0) return;
  }
}
