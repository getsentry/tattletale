// Parse a transcript, build spans, send only what the ledger hasn't seen. Safe to run any number of times.

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { listClaudeSessions, parseClaude } from "./claude.ts";
import { listCodexSessions, parseCodex } from "./codex.ts";
import { isOpencodeSnapshot, listOpencodeSessions, opencodeSnapshot, parseOpencode } from "./opencode.ts";
import { isPiSession, listPiSessions, parsePi } from "./pi.ts";
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
  markUnverified,
  queueLength,
  recoverPending,
  takeJobs,
  tryLock,
  withLock,
  writePending,
} from "./state.ts";
import type { Config } from "./state.ts";
import { reportError } from "./report.ts";
import { inScope, repoOf } from "./scope.ts";
import { VERSION } from "./version.ts";

export function detectAgent(path: string): AgentName {
  if (isOpencodeSnapshot(path)) return "opencode";
  if (isPiSession(path)) return "pi";
  return /(^|\/)\.codex\/|rollout-[^/]*\.jsonl/.test(path) ? "codex" : "claude-code";
}

export function parseSession(path: string, agent: AgentName = detectAgent(path), opts: ParseOptions = {}): Session {
  if (agent === "opencode") return parseOpencode(path, opts);
  if (agent === "pi") return parsePi(path, opts);
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
  /** Sentry can't be reached or refuses us (network, outage, bad DSN): other sessions would fail the same way. */
  stop?: boolean;
}

/** The relay sees an OTel session within seconds of its first turn; one it still hasn't seen this long after its
 *  first turn since the switch is running without telemetry (e.g. opened before the switch). */
const OTEL_UNSEEN_MS = 10 * 60 * 1000;
/** The transcript stamps a prompt slightly before Claude Code's OTel turn span starts. Telemetry is on from process
 *  start, so a resumed session's earlier turns are far older than this; a misjudged turn is skipped, never doubled. */
const OTEL_OVERLAP_MS = 2 * 60 * 1000;

/**
 * With claudeSource "otel", each Claude Code session has exactly one source so Sentry never gets it twice:
 * turns from before the relay first saw the session come from the transcript, the rest from OTel. A session
 * the relay hasn't seen 10 minutes after its first turn since the switch belongs to the transcript.
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
  const since = config.otelSince;
  if (since === undefined || mtimeMs < since) return "ok";
  const firstAfterSwitch = Math.min(...session.turns.filter((t) => t.start >= since).map((t) => t.start));
  if (!Number.isFinite(firstAfterSwitch)) return "ok";
  return now - firstAfterSwitch >= OTEL_UNSEEN_MS ? "ok" : "wait";
}

/** Sends one batch; on a non-retryable rejection, bisects to isolate (and skip) the bad span. */
async function sendBatch(sink: Sink, key: string, batch: OtlpSpan[], report: SyncReport): Promise<boolean> {
  const ids = batch.map((s) => s.spanId);
  writePending(key, ids);
  const res = await sink.send(batch);
  // The ledger first: a crash between the two lines must not leave sent spans unrecorded.
  if (res.ok) markSent(ids);
  // No answer, and Sentry may have the batch: the same at-most-once rule as a crash mid-send.
  else if (res.maybeDelivered) markUnverified(ids);
  clearPending(key);
  if (res.ok) {
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
    report.stop = true;
    log(
      res.maybeDelivered
        ? `${key}: no answer from Sentry; ${ids.length} spans may have arrived and won't be sent again: ${res.message}`
        : `${key}: send failed (will retry): ${res.message}`,
    );
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
  const sink = opts.sink ?? (config.dsn ? sentrySink(config.dsn) : undefined);
  if (!sink && !opts.dryRun)
    return { ...report, error: "no DSN configured (run: tattletale setup --dsn ...)", stop: true };

  const session = parseSession(path, agent, { final: opts.final, now: opts.now });
  report.sessionId = session.sessionId;
  if (!inScope(session.cwd, config)) return { ...report, skipped: "ignored path" };
  session.repo = repoOf(session.cwd);
  if (applyOtelOwnership(session, config, opts.now ?? Date.now(), statSync(path).mtimeMs) === "wait")
    return { ...report, skipped: "waiting for OTel relay" };
  const spans = buildSpans(session, { content: config.content, environment: config.environment, user: config.user });
  report.built = spans.length;
  const complete = session.turns.every((t) => t.complete) && session.subagents.every((s) => s.complete);

  // One sender at a time on this machine: the ledger is read and extended under this lock, so two
  // processes (the hook worker and a manual replay, say) can never both decide to send the same span.
  const key = `${agent}:${session.sessionId}`;
  const done = await withLock("send", async () => {
    if (!opts.dryRun) recoverPending();
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
  if (!done) return { ...report, error: "another tattletale process is sending; will retry" };
  report.settled = complete && report.failed === 0 && !opts.dryRun;
  return report;
}

// ---- background worker ----

interface FileMark {
  mtimeMs: number;
  settled: boolean;
  /** The tattletale version that crashed on this transcript. */
  crashed?: string;
}

function loadMarks(): Record<string, FileMark> {
  try {
    return JSON.parse(readFileSync(join(home(), "files.json"), "utf8"));
  } catch {
    return {};
  }
}

/** Changes marks under a lock, re-reading the file first: the worker and a manual replay both write it. */
async function updateMarks(change: (marks: Record<string, FileMark>) => void): Promise<void> {
  await withLock(
    "marks",
    async () => {
      const marks = loadMarks();
      change(marks);
      const path = join(home(), "files.json");
      writeFileSync(`${path}.${process.pid}.tmp`, JSON.stringify(marks));
      renameSync(`${path}.${process.pid}.tmp`, path);
    },
    5_000,
  ).catch(() => {});
}

const FINAL_EVENTS = new Set(["Stop", "SessionEnd", "stop", "sessionEnd"]);

/**
 * Transcripts that may still have something to send. Recent ones that are new or changed (sessions whose
 * hooks never fired), and every one not settled however old: nothing else retries a send that failed.
 */
export function sweepCandidates(days: number, marks: Record<string, FileMark>): { path: string; agent: AgentName }[] {
  const since = Date.now() - days * 86_400_000;
  const paths = new Set([
    ...listClaudeSessions(since),
    ...listCodexSessions(since),
    ...listOpencodeSessions(since),
    ...listPiSessions(since),
  ]);
  for (const [path, mark] of Object.entries(marks)) if (!mark.settled && existsSync(path)) paths.add(path);
  return [...paths]
    .filter((path) => {
      const mark = marks[path];
      if (!mark) return true;
      const changed = mark.mtimeMs !== statSync(path).mtimeMs;
      // One that crashed us is left alone until it changes or tattletale is upgraded, not retried every sweep.
      if (mark.crashed) return changed || mark.crashed !== VERSION;
      return !mark.settled || changed;
    })
    .map((path) => ({ path, agent: detectAgent(path) }));
}

const SWEEP_EVERY_MS = 5 * 60 * 1000;

/** True at most once per interval, across processes: sweeps ride on hook events without running on each. */
function sweepDue(): boolean {
  const stamp = join(home(), "last-sweep");
  try {
    if (Date.now() - statSync(stamp).mtimeMs < SWEEP_EVERY_MS) return false;
  } catch {}
  writeFileSync(stamp, "");
  return true;
}

export async function syncMany(
  items: { path: string; agent?: AgentName; final?: boolean }[],
  opts: SyncOptions = {},
  onReport?: (r: SyncReport) => void,
): Promise<SyncReport[]> {
  const reports: SyncReport[] = [];
  const blank = (item: { path: string; agent?: AgentName }, extra: Partial<SyncReport>): SyncReport => ({
    path: item.path,
    agent: item.agent ?? detectAgent(item.path),
    built: 0,
    alreadySent: 0,
    sent: 0,
    failed: 0,
    poisoned: 0,
    rejected: 0,
    settled: false,
    ...extra,
  });
  let stopped = false;
  for (const item of items) {
    let report: SyncReport;
    if (!existsSync(item.path)) {
      // SessionStart fires before the agent has written its transcript.
      reports.push(blank(item, { skipped: "missing" }));
      continue;
    }
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(item.path).mtimeMs;
      if (stopped) {
        // Sentry can't be reached: leave the rest unsettled for the next sweep rather than fail one by one.
        report = blank(item, { skipped: "not tried, will retry" });
      } else {
        report = await syncTranscript(item.path, { ...opts, agent: item.agent, final: item.final });
        stopped = report.stop === true;
      }
      // Intentionally skipped sessions count as settled until the file changes, so sweeps don't re-parse them.
      const settled = report.settled || report.skipped === "ignored path";
      if (!opts.dryRun) await updateMarks((marks) => void (marks[item.path] = { mtimeMs, settled }));
    } catch (err) {
      report = blank(item, { error: String((err as Error)?.stack ?? err) });
      log(`sync ${item.path} crashed: ${report.error}`);
      if (!opts.dryRun)
        await updateMarks((marks) => void (marks[item.path] = { mtimeMs, settled: false, crashed: VERSION }));
      await reportError(err, { stage: "sync", agent: report.agent });
    }
    reports.push(report);
    onReport?.(report);
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
          let path = job.transcriptPath;
          // OpenCode has no transcript file: its plugin names the session, and we snapshot it from its database.
          if (!path && job.agent === "opencode" && job.sessionId) {
            try {
              path = opencodeSnapshot(job.sessionId);
            } catch (err) {
              log(`opencode snapshot of ${job.sessionId} failed: ${(err as Error)?.stack ?? err}`);
              await reportError(err, { stage: "opencode-snapshot", agent: "opencode" });
            }
          }
          if (!path) continue;
          const entry = byPath.get(path) ?? { path, agent: job.agent as AgentName | undefined, final: false };
          // A subagent's session going idle doesn't end its parent's turn.
          const own = job.agent !== "opencode" || basename(path) === `${job.sessionId}.json`;
          entry.final ||= own && FINAL_EVENTS.has(job.event ?? "");
          byPath.set(path, entry);
        }
        const reports = await syncMany([...byPath.values()]);
        for (const r of reports)
          log(
            `sync ${r.agent} ${r.sessionId ?? r.path}: built=${r.built} sent=${r.sent} already=${r.alreadySent} failed=${r.failed}${r.skipped ? ` skipped=${r.skipped}` : ""}${r.error ? ` error=${r.error}` : ""}`,
          );
        const due = sweepDue();
        if (sweep || due) {
          await updateMarks((marks) => {
            for (const path of Object.keys(marks)) if (!existsSync(path)) delete marks[path];
          });
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
