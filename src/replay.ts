// Which transcripts a replay sends: the agents' own transcript folders filtered by date, or explicit files and
// folders (e.g. copied from another machine). Oldest first, so an original session claims history that a later
// fork copied. Sending goes through syncMany, so the ledger, scope and OTel ownership rules all apply.

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { listClaudeSessions } from "./claude.ts";
import { listCodexSessions } from "./codex.ts";
import type { AgentName } from "./model.ts";
import { detectAgent } from "./sync.ts";

export interface ReplayOptions {
  /** Files or folders; empty means the agents' own transcript folders. */
  paths: string[];
  agent?: AgentName;
  /** Only transcripts last modified in this window (epoch ms). */
  since?: number;
  until?: number;
  /** Only these session IDs (or prefixes). */
  sessions: string[];
  limit?: number;
}

const TRANSCRIPT = /\.jsonl(\.zst)?$/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    // A Claude session's subagents are read together with its main transcript.
    if (st.isDirectory()) {
      if (name !== "subagents") walk(path, out);
    } else if (TRANSCRIPT.test(name)) out.push(path);
  }
}

export interface ReplayTarget {
  path: string;
  agent: AgentName;
  mtimeMs: number;
  /** Explicit files are history: their last turn is finished. The agents' own folders may hold live sessions. */
  final: boolean;
}

export function replayTargets(opts: ReplayOptions): ReplayTarget[] {
  let paths: string[] = [];
  if (opts.paths.length) {
    for (const p of opts.paths.map((x) => resolve(x))) {
      if (!existsSync(p)) throw new Error(`no such file or folder: ${p}`);
      if (statSync(p).isDirectory()) walk(p, paths);
      else paths.push(p);
    }
  } else {
    if (opts.agent !== "codex") paths.push(...listClaudeSessions(opts.since ?? 0));
    if (opts.agent !== "claude-code") paths.push(...listCodexSessions(opts.since ?? 0));
  }
  paths = [...new Set(paths)];
  const items = paths
    .map((path) => ({ path, agent: detectAgent(path), mtimeMs: statSync(path).mtimeMs, final: opts.paths.length > 0 }))
    .filter((t) => !opts.agent || t.agent === opts.agent)
    .filter((t) => opts.since === undefined || t.mtimeMs >= opts.since)
    .filter((t) => opts.until === undefined || t.mtimeMs <= opts.until)
    .filter((t) => !opts.sessions.length || opts.sessions.some((id) => basename(t.path).includes(id)))
    .toSorted((a, b) => a.mtimeMs - b.mtimeMs);
  return opts.limit ? items.slice(0, opts.limit) : items;
}

/** "2026-10-01", "2026-10-01T12:00", or a number of days ago ("30d"). */
export function parseWhen(value: string, now = Date.now()): number {
  const days = /^(\d+)d$/.exec(value);
  if (days) return now - Number(days[1]) * 86_400_000;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`can't read date "${value}" (use 2026-10-01 or 30d)`);
  return ms;
}
