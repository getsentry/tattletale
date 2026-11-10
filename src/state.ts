// Local state under ~/.tattletale (override with TATTLETALE_HOME):
//   config.json    DSN and options
//   sent.log       every span ID Sentry accepted, one per line (the dedup ledger)
//   pending/       span IDs of a batch in flight; survives a crash between send and ledger write
//   unverified.log span IDs from batches whose outcome is unknown after a crash (never re-sent)
//   queue/         wake-up jobs written by hooks, drained by the background worker
//   locks/         the send lock (one sender at a time) and the worker lock
//   files.json     per-transcript marks: which ones are fully sent
//   tattletale.log

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { ContentMode } from "./spans.ts";
import { hashHex } from "./util.ts";

export interface Config {
  dsn?: string;
  content: ContentMode;
  environment: string;
  user?: string;
  /** Path prefixes whose sessions are never sent. */
  ignore: string[];
  /** If set, only sessions under these path prefixes are sent. */
  include: string[];
  disabled: boolean;
  /** Where Claude Code data comes from: its transcripts, or its native OpenTelemetry via the local relay. */
  claudeSource: "transcript" | "otel";
  /** When claudeSource switched to otel (ms). Sessions untouched since then stay on transcripts. */
  otelSince?: number;
  relayPort: number;
}

export function home(): string {
  return process.env.TATTLETALE_HOME ?? join(homedir(), ".tattletale");
}

function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export function loadConfig(): Config {
  let file: Partial<Config> = {};
  try {
    file = JSON.parse(readFileSync(join(home(), "config.json"), "utf8"));
  } catch {}
  const env = process.env;
  return {
    dsn: env.TATTLETALE_DSN ?? file.dsn,
    content: (env.TATTLETALE_CONTENT as ContentMode) ?? file.content ?? "full",
    environment: env.TATTLETALE_ENVIRONMENT ?? file.environment ?? "local",
    user: file.user ?? safeUser(),
    ignore: file.ignore ?? [],
    include: file.include ?? [],
    disabled: env.TATTLETALE_DISABLED === "1" || file.disabled === true,
    claudeSource: file.claudeSource === "otel" ? "otel" : "transcript",
    otelSince: file.otelSince,
    relayPort: Number(env.TATTLETALE_RELAY_PORT ?? file.relayPort ?? 43181),
  };
}

function safeUser(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

export function saveConfig(patch: Partial<Config>): Config {
  ensureDir(home());
  let current: Partial<Config> = {};
  try {
    current = JSON.parse(readFileSync(join(home(), "config.json"), "utf8"));
  } catch {}
  const next = { ...current, ...patch };
  writeFileSync(join(home(), "config.json"), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return loadConfig();
}

export function log(message: string): void {
  try {
    ensureDir(home());
    appendFileSync(join(home(), "tattletale.log"), `${new Date().toISOString()} [${process.pid}] ${message}\n`);
  } catch {}
}

// ---- dedup ledger ----

let sentCache: Set<string> | undefined;
/** How far each ledger file has been read, by path. */
const ledgerRead = new Map<string, number>();

function readIds(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

/** Adds the IDs appended to a ledger file since the last call. */
function readNewIds(name: string, into: Set<string>): void {
  const path = join(home(), name);
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return;
  }
  try {
    const size = fstatSync(fd).size;
    let from = ledgerRead.get(path) ?? 0;
    if (size < from) from = 0;
    if (size === from) return;
    const buf = Buffer.alloc(size - from);
    const text = buf.subarray(0, readSync(fd, buf, 0, buf.length, from)).toString("latin1");
    // Stop at the last complete line: another process may be in the middle of appending.
    const end = text.lastIndexOf("\n") + 1;
    for (const id of text.slice(0, end).split("\n")) if (id) into.add(id);
    ledgerRead.set(path, from + end);
  } finally {
    closeSync(fd);
  }
}

/**
 * Every span ID already sent. Other processes append to the ledger too (a manual replay next to the hook
 * worker), so each call picks up what they added: check it while holding the send lock.
 */
export function loadSent(): Set<string> {
  sentCache ??= new Set();
  readNewIds("sent.log", sentCache);
  readNewIds("unverified.log", sentCache);
  return sentCache;
}

export function markSent(ids: string[]): void {
  if (!ids.length) return;
  ensureDir(home());
  appendFileSync(join(home(), "sent.log"), ids.join("\n") + "\n");
  const set = loadSent();
  for (const id of ids) set.add(id);
}

/** Records IDs whose delivery is unknown: they are never sent again, so they can be lost but not doubled. */
export function markUnverified(ids: string[]): void {
  if (!ids.length) return;
  ensureDir(home());
  appendFileSync(join(home(), "unverified.log"), ids.join("\n") + "\n");
  const set = loadSent();
  for (const id of ids) set.add(id);
}

export function resetSentCache(): void {
  sentCache = undefined;
  ledgerRead.clear();
}

const pendingPath = (key: string) => join(ensureDir(join(home(), "pending")), `${hashHex(16, key)}.json`);

export function writePending(key: string, ids: string[]): void {
  writeFileSync(pendingPath(key), JSON.stringify({ key, ids, at: Date.now() }));
}

export function clearPending(key: string): void {
  rmSync(pendingPath(key), { force: true });
}

/**
 * A pending file means a process died after sending a batch but before recording the result. Sentry may
 * or may not have it. We choose at-most-once: record those IDs as unverified and never re-send them, so
 * a crash can lose a batch but can never double count tokens. Call while holding the send lock: then no
 * batch is in flight, and every pending file is a leftover.
 */
export function recoverPending(): number {
  const dir = join(home(), "pending");
  if (!existsSync(dir)) return 0;
  let recovered = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    let batch: { key?: string; ids?: string[] } = {};
    try {
      batch = JSON.parse(readFileSync(path, "utf8"));
    } catch {}
    const ids = batch.ids ?? [];
    markUnverified(ids);
    if (ids.length) log(`recovered pending batch for ${batch.key}: ${ids.length} spans marked unverified`);
    rmSync(path, { force: true });
    recovered += ids.length;
  }
  return recovered;
}

// ---- locks ----

export const STALE_LOCK_MS = 10 * 60 * 1000;
const LOCK_HEARTBEAT_MS = 60 * 1000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function readLock(path: string): { token: string; mtimeMs: number } | undefined {
  try {
    return { token: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * A lock file holds "<pid> <random>", and its holder touches it every minute. It is stale when the
 * holder's process is gone, or when nobody touched it for 10 minutes (a reused PID, a hung holder).
 * Returns the release function, which only removes the lock if this process still holds it.
 */
export function tryLock(name: string): (() => void) | undefined {
  const path = join(ensureDir(join(home(), "locks")), `${name}.lock`);
  const nonce = randomBytes(8).toString("hex");
  const token = `${process.pid} ${nonce}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, token);
      closeSync(fd);
    } catch {
      const seen = readLock(path);
      if (!seen) continue;
      // An empty file is a holder between creating the lock and writing its token.
      const dead = seen.token !== "" && !pidAlive(Number(seen.token.split(" ")[0]));
      if (!dead && Date.now() - seen.mtimeMs <= STALE_LOCK_MS) return undefined;
      // Move the stale file aside rather than delete it: only one process can, and it can tell whether
      // it moved the file it judged or a fresh lock someone took in between (then it puts that back).
      const aside = `${path}.${nonce}.stale`;
      try {
        renameSync(path, aside);
      } catch {
        continue;
      }
      if (readLock(aside)?.token !== seen.token) {
        try {
          linkSync(aside, path);
        } catch {}
      }
      rmSync(aside, { force: true });
      continue;
    }
    const owns = () => readLock(path)?.token === token;
    const beat = setInterval(() => {
      try {
        const now = new Date();
        if (owns()) utimesSync(path, now, now);
      } catch {}
    }, LOCK_HEARTBEAT_MS);
    beat.unref();
    return () => {
      clearInterval(beat);
      if (owns()) rmSync(path, { force: true });
    };
  }
  return undefined;
}

export async function withLock<T>(name: string, fn: () => Promise<T>, waitMs = 60_000): Promise<T | undefined> {
  const deadline = Date.now() + waitMs;
  let release = tryLock(name);
  while (!release && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    release = tryLock(name);
  }
  if (!release) return undefined;
  try {
    return await fn();
  } finally {
    release();
  }
}

// ---- queue ----

export interface Job {
  agent?: string;
  event?: string;
  sessionId?: string;
  transcriptPath?: string;
  at: number;
}

/**
 * The queue is a wake-up signal, not a work log: a job only says "look at this transcript now". Jobs are
 * removed before they are worked on, so one that crashes the worker is not retried in a loop. What a
 * lost job would have sent is found by the sweep, which goes by the transcripts and the ledger.
 */
export function enqueue(job: Job): void {
  const dir = ensureDir(join(home(), "queue"));
  const name = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  // Written under a name the worker skips, then renamed, so the worker never reads half a job.
  writeFileSync(join(dir, `${name}.tmp`), JSON.stringify(job));
  renameSync(join(dir, `${name}.tmp`), join(dir, `${name}.json`));
}

function jobFiles(): string[] {
  const dir = join(home(), "queue");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .toSorted()
    .map((n) => join(dir, n));
}

export function takeJobs(): Job[] {
  const jobs: Job[] = [];
  for (const path of jobFiles()) {
    try {
      jobs.push(JSON.parse(readFileSync(path, "utf8")));
    } catch {}
    rmSync(path, { force: true });
  }
  return jobs;
}

export function queueLength(): number {
  return jobFiles().length;
}

export function countLines(name: string): number {
  return readIds(join(home(), name)).length;
}

// ---- OTel ownership: sessions the relay has seen, with the time of their first OTel span ----

export function markOtelSession(sessionId: string, firstSeenMs: number): void {
  ensureDir(home());
  appendFileSync(join(home(), "otel-sessions.log"), `${sessionId}\t${Math.round(firstSeenMs)}\n`);
}

export function loadOtelSessions(): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of readIds(join(home(), "otel-sessions.log"))) {
    const [id, ms] = line.split("\t");
    const t = Number(ms);
    if (id && Number.isFinite(t) && !(out.has(id) && out.get(id)! <= t)) out.set(id, t);
  }
  return out;
}
