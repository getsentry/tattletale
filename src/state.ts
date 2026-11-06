// Local state under ~/.tattletale (override with TATTLETALE_HOME):
//   config.json    DSN and options
//   sent.log       every span ID Sentry accepted, one per line (the dedup ledger)
//   pending/       span IDs of a batch in flight; survives a crash between send and ledger write
//   unverified.log span IDs from batches whose outcome is unknown after a crash (never re-sent)
//   queue/         jobs written by hooks, drained by the background worker
//   locks/         per-session and worker locks
//   tattletale.log

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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

function readIds(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

export function loadSent(): Set<string> {
  if (!sentCache)
    sentCache = new Set([...readIds(join(home(), "sent.log")), ...readIds(join(home(), "unverified.log"))]);
  return sentCache;
}

export function markSent(ids: string[]): void {
  if (!ids.length) return;
  ensureDir(home());
  appendFileSync(join(home(), "sent.log"), ids.join("\n") + "\n");
  const set = loadSent();
  for (const id of ids) set.add(id);
}

export function resetSentCache(): void {
  sentCache = undefined;
}

const pendingPath = (key: string) => join(ensureDir(join(home(), "pending")), `${hashHex(16, key)}.json`);

export function writePending(key: string, ids: string[]): void {
  writeFileSync(pendingPath(key), JSON.stringify({ key, ids, at: Date.now() }));
}

export function clearPending(key: string): void {
  rmSync(pendingPath(key), { force: true });
}

/**
 * A pending file means we crashed after sending a batch but before recording the result. Sentry may or
 * may not have it. We choose at-most-once: record those IDs as unverified and never re-send them, so a
 * crash can lose a batch but can never double count tokens.
 */
export function recoverPending(key: string): number {
  const path = pendingPath(key);
  if (!existsSync(path)) return 0;
  let ids: string[] = [];
  try {
    ids = JSON.parse(readFileSync(path, "utf8")).ids ?? [];
  } catch {}
  if (ids.length) {
    appendFileSync(join(home(), "unverified.log"), ids.join("\n") + "\n");
    const set = loadSent();
    for (const id of ids) set.add(id);
    log(`recovered pending batch for ${key}: ${ids.length} spans marked unverified`);
  }
  rmSync(path, { force: true });
  return ids.length;
}

// ---- locks ----

const STALE_LOCK_MS = 10 * 60 * 1000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function tryLock(name: string): (() => void) | undefined {
  const path = join(ensureDir(join(home(), "locks")), `${name}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch {
      let stale = false;
      try {
        const pid = Number(readFileSync(path, "utf8"));
        stale = !pidAlive(pid) || Date.now() - statSync(path).mtimeMs > STALE_LOCK_MS;
      } catch {
        stale = true;
      }
      if (!stale) return undefined;
      rmSync(path, { force: true });
    }
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

export function enqueue(job: Job): void {
  const dir = ensureDir(join(home(), "queue"));
  writeFileSync(
    join(dir, `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`),
    JSON.stringify(job),
  );
}

export function takeJobs(): Job[] {
  const dir = join(home(), "queue");
  if (!existsSync(dir)) return [];
  const jobs: Job[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    const path = join(dir, name);
    try {
      jobs.push(JSON.parse(readFileSync(path, "utf8")));
    } catch {}
    rmSync(path, { force: true });
  }
  return jobs;
}

export function queueLength(): number {
  const dir = join(home(), "queue");
  return existsSync(dir) ? readdirSync(dir).length : 0;
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
